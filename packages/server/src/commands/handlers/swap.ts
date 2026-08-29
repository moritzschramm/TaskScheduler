import { and, eq, sql } from 'drizzle-orm';
import { validateSchedule, type Placement } from '@ambitime/scheduler';
import { placements, taskOccurrences } from '../../db/schema/index.js';
import { lockTask, type CommandContext, type HandlerOutcome } from '../context.js';
import { requireActive, requireLeaf } from '../entities.js';
import { PreconditionFailedError } from '../errors.js';
import { updateRow } from '../journal.js';
import { isoText, toInstant, toInstantCeil, toIso } from '../../schedule/instants.js';
import { loadScheduleContext } from '../../schedule/load-context.js';
import type { SwapForwardParams, SwapTasksParams } from '@ambitime/shared';
import type { Task } from '../../db/schema/index.js';

/**
 * The two swap actions of spec §7.3.
 *
 * Both are about *positions*, which the system does not store — a position is
 * derived. So both are expressed the only way a command may express anything:
 * as constraints on the source, chosen so that re-derivation produces the
 * exchange on its own.
 *
 * That indirection is not a workaround. It is what keeps a swap honest: the
 * user asks for two tasks to trade places, and gets two tasks that trade places
 * *if the calendar allows it*, rather than a pair of pinned assignments that
 * quietly violate a window or a deadline.
 */

/**
 * `SwapForward(task)` — "I don't want to work on this now" (spec §7.3).
 *
 * One write: a floor at the end of the slot the task currently holds. That is
 * the whole command, and it produces both halves of what §7.3 describes.
 *
 * The task moves to its next feasible slot because the floor forbids the one it
 * had. The next feasible task is pulled into the vacated slot because the slot
 * is now free and `earliness` (§6.5) makes the solver want it — nothing has to
 * hunt for a replacement, because re-derivation is already choosing for every
 * task at once.
 *
 * `defer_count` is left alone. §7.3 gives the increment to `DeferTask`, and the
 * signal it feeds (§6.6) is about tasks that never get done — shuffling the
 * order of a day someone is actively working is the opposite of that. The log
 * records every swap, so a later reading can still find the user who does this
 * to the same task every morning.
 */
export async function swapForward(
  params: SwapForwardParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);
  await requireLeaf(ctx, task);

  return { calendarIds: [await deferPastCurrentSlot(ctx, task)] };
}

/**
 * `SwapTasks(taskA, taskB)` — trade places (spec §7.3).
 *
 * "Exchange time positions **if each fits the other's constraints**; otherwise
 * fall back to `SwapForward` semantics." Both halves are here, and the
 * feasibility test is the engine's own hard-constraint validator (§6.2) run
 * over the two proposed placements — so "fits" means precisely what it means
 * everywhere else in the system, rather than a second opinion that could drift
 * from the first.
 *
 * What is checked is each task against *its own* constraints in the other's
 * slot: windows, fixed blocks, deadlines, sequences, and the two against each
 * other. Not the rest of the schedule — a third task displaced by the exchange
 * is not an obstacle, it is something that reflows, which is what the whole
 * design is for.
 */
export async function swapTasks(
  params: SwapTasksParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  // Locked in id order: two users swapping the same pair from opposite ends
  // would otherwise each hold what the other is waiting for.
  const [firstId, secondId] = [params.taskAId, params.taskBId].sort();
  const locked = new Map<string, Task>();
  for (const id of [firstId!, secondId!]) locked.set(id, await lockTask(ctx, id));

  const a = locked.get(params.taskAId)!;
  const b = locked.get(params.taskBId)!;

  for (const task of [a, b]) {
    requireActive(task);
    await requireLeaf(ctx, task);
  }

  if (a.calendarId !== b.calendarId) {
    throw new PreconditionFailedError('Tasks in different calendars have no positions to exchange');
  }

  const placementA = await currentPlacement(ctx, a.id);
  const placementB = await currentPlacement(ctx, b.id);

  // Nothing to trade: the other task is in the backlog, or already under way and
  // so no longer holding a slot anyone can be moved into. §7.3's own fallback.
  if (placementA === undefined) {
    throw new PreconditionFailedError(`Task ${a.id} holds no slot to swap out of`);
  }
  if (placementB === undefined || !(await swapFits(ctx, a.calendarId, placementA, placementB))) {
    return { calendarIds: [await deferPastCurrentSlot(ctx, a)] };
  }

  // Floor and bias together, exactly as `MoveTask` sets them (§7.3): not before
  // there, and there if the calendar allows. Neither task is pinned.
  await updateRow(ctx, 'tasks', a.id, {
    manualFloor: toIso(placementB.interval.start),
    manualBias: toIso(placementB.interval.start),
  });
  await updateRow(ctx, 'tasks', b.id, {
    manualFloor: toIso(placementA.interval.start),
    manualBias: toIso(placementA.interval.start),
  });

  return { calendarIds: [a.calendarId] };
}

/** The shared write of both commands: a floor just past the slot in hand. */
async function deferPastCurrentSlot(ctx: CommandContext, task: Task): Promise<string> {
  const placement = await currentPlacement(ctx, task.id);
  if (placement === undefined) {
    throw new PreconditionFailedError(
      `Task ${task.id} holds no slot, so there is nothing to move it out of`,
    );
  }

  await updateRow(ctx, 'tasks', task.id, {
    manualFloor: toIso(placement.interval.end),
    // The bias pointed at the slot the user has just refused.
    manualBias: null,
  });

  return task.calendarId;
}

/**
 * Whether each task's hard constraints admit the other's start time.
 *
 * Both slots must still be ahead of `now`. A task already under way cannot be
 * moved out of a slot it is partly through, and the slot it would vacate is not
 * a whole slot any more — the same reason §7.2's bulk reflow leaves the block
 * straddling `now` where it is.
 */
async function swapFits(
  ctx: CommandContext,
  calendarId: string,
  placementA: Placement,
  placementB: Placement,
): Promise<boolean> {
  if (placementA.interval.start < ctx.now || placementB.interval.start < ctx.now) return false;

  const { context } = await loadScheduleContext({
    tx: ctx.tx,
    calendarId,
    now: ctx.now,
    config: ctx.config,
  });

  const durationOf = new Map(
    context.schedulables.map((schedulable) => [schedulable.occurrenceId, schedulable.durationMin]),
  );
  const durationA = durationOf.get(placementA.occurrenceId);
  const durationB = durationOf.get(placementB.occurrenceId);
  if (durationA === undefined || durationB === undefined) return false;

  const startA = placementB.interval.start;
  const startB = placementA.interval.start;

  // The floors the swap is about to write, so the validator judges the state
  // that would exist afterwards rather than the one being replaced. Without
  // this, a task the user had already repositioned would veto its own swap.
  const proposed = {
    ...context,
    schedulables: context.schedulables.map((schedulable) => {
      if (schedulable.occurrenceId === placementA.occurrenceId) {
        return { ...schedulable, manualFloor: startA, manualBias: startA };
      }
      if (schedulable.occurrenceId === placementB.occurrenceId) {
        return { ...schedulable, manualFloor: startB, manualBias: startB };
      }
      return schedulable;
    }),
  };

  const swapped: Placement[] = [
    { ...placementA, interval: { start: startA, end: startA + durationA } },
    { ...placementB, interval: { start: startB, end: startB + durationB } },
  ];

  return validateSchedule(proposed, swapped).valid;
}

/**
 * The slot a task holds right now, read out of the derived cache.
 *
 * A read of derived state inside a command, which is unusual and deliberate:
 * "the position you can see" is exactly what the user is pointing at when they
 * drag one task onto another, and the cache is where that lives. Nothing is
 * written back to it — what the handler writes is a constraint.
 */
async function currentPlacement(
  ctx: CommandContext,
  taskId: string,
): Promise<Placement | undefined> {
  const [row] = await ctx.tx
    .select({
      occurrenceId: placements.occurrenceId,
      startAt: isoText(sql`lower(${placements.during})`),
      endAt: isoText(sql`upper(${placements.during})`),
      cooldownMin: placements.cooldownMin,
    })
    .from(placements)
    .innerJoin(taskOccurrences, eq(taskOccurrences.id, placements.occurrenceId))
    .where(and(eq(taskOccurrences.taskId, taskId), eq(taskOccurrences.status, 'pending')))
    .orderBy(sql`lower(${placements.during})`)
    .limit(1);

  if (!row) return undefined;

  return {
    occurrenceId: row.occurrenceId,
    interval: { start: toInstant(row.startAt), end: toInstantCeil(row.endAt) },
    cooldownMin: row.cooldownMin,
  };
}
