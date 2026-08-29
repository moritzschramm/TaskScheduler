import { and, eq } from 'drizzle-orm';
import { computeHardHorizon, type Instant } from '@ambitime/scheduler';
import { taskOccurrences } from '../../db/schema/index.js';
import { lockTask, type CommandContext, type HandlerOutcome } from '../context.js';
import { calendarTimeZone, requireActive, requireLeaf } from '../entities.js';
import { updateRow, updateWhere } from '../journal.js';
import { toIso } from '../../schedule/instants.js';
import { startOfNextDay, startOfNextWeek } from '../../schedule/local-days.js';
import type { CompleteTaskParams, DeferTaskParams, MoveTaskParams } from '@ambitime/shared';

/**
 * Single-task manual actions (spec §7.3).
 *
 * The rule these share is the one the whole architecture turns on: **a manual
 * edit changes a constraint, it does not freeze an assignment** (§3.4). None of
 * these handlers writes a placement. They write a floor, a bias, a status — and
 * re-derivation decides what the schedule makes of that.
 *
 * That is what "manually changed tasks are delayed, not fixed" means in code: a
 * repositioned task can still be moved by a hard constraint or outranked by a
 * more urgent one, but never back before its floor.
 */

/**
 * `MoveTask(task, datetime)` — a manual reposition (spec §7.3).
 *
 * Sets a soft not-before *and* a preference for the same datetime. The two do
 * different jobs: the floor is a hard filter the solver will not cross, the
 * bias is a scored preference that pulls the task towards where it was
 * dropped. Together they mean "not before here, and here if you can".
 */
export async function moveTask(
  params: MoveTaskParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);
  await requireLeaf(ctx, task);

  await updateRow(ctx, 'tasks', task.id, {
    manualFloor: params.datetime,
    manualBias: params.datetime,
  });

  return { calendarIds: [task.calendarId] };
}

/**
 * `DeferTask(task, target)` — "not now" (spec §7.3).
 *
 * The target becomes a floor, because "tomorrow", "next week" and "the backlog"
 * are all statements about the earliest acceptable time. `backlog` floors the
 * task at the end of the hard horizon, which is not a special case in the
 * solver: nothing can be placed past the horizon, so the coarse weekly planner
 * picks it up and gives it an estimated week (§6.1).
 *
 * This is the *user-initiated* deferral of §6.6, and the only thing in M6 that
 * increments `defer_count`. A bulk reflow moves far more tasks and touches none
 * of these counters — see `bulk.ts`.
 */
export async function deferTask(
  params: DeferTaskParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);
  await requireLeaf(ctx, task);

  const timeZone = await calendarTimeZone(ctx, task.calendarId);

  await updateRow(ctx, 'tasks', task.id, {
    manualFloor: toIso(deferFloor(params.target, ctx, timeZone)),
    // "Sets nothing fixed" (§7.3). An earlier reposition's bias pointed at a
    // time the user has just rejected, so keeping it would pull the task
    // straight back to the edge of its new floor.
    manualBias: null,
    // Read from the locked row rather than incremented in SQL, so the journal
    // records a number it can put back. `lockTask` holds the row, so nothing
    // can slip between the read and the write (§5.4).
    deferCount: task.deferCount + 1,
    lastDeferReason: params.reason ?? null,
    lastDeferAt: ctx.nowIso,
  });

  return { calendarIds: [task.calendarId] };
}

function deferFloor(
  target: DeferTaskParams['target'],
  ctx: CommandContext,
  timeZone: string,
): Instant {
  switch (target) {
    case 'tomorrow':
      return startOfNextDay(ctx.now, timeZone);
    case 'next_week':
      return startOfNextWeek(ctx.now, timeZone, ctx.config);
    case 'backlog':
      return computeHardHorizon(ctx.now, timeZone, ctx.config).end;
  }
}

/**
 * `CompleteTask(task, actual_end?)` — done (spec §7.3).
 *
 * The slot and its cooldown are freed by re-derivation rather than by deleting
 * a row: a completed occurrence is no longer pending, so it is not loaded as
 * demand, so the recomputed cache simply does not contain it. Downstream tasks
 * then reflow into the time it gave back, which is how finishing early pulls
 * the day forward (§7.6).
 *
 * The floor is cleared here because §7.3 says completion is one of the three
 * things that clears one.
 */
export async function completeTask(
  params: CompleteTaskParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);
  await requireLeaf(ctx, task);

  const completedAt = params.actualEnd ?? ctx.nowIso;

  await updateRow(ctx, 'tasks', task.id, { status: 'completed', completedAt, manualFloor: null });

  await updateWhere(
    ctx,
    'task_occurrences',
    and(eq(taskOccurrences.taskId, task.id), eq(taskOccurrences.status, 'pending'))!,
    { status: 'completed', completedAt },
  );

  return { calendarIds: [task.calendarId] };
}
