import { and, eq, inArray, sql } from 'drizzle-orm';
import { computeHardHorizon } from '@ambitime/scheduler';
import { taskOccurrences, tasks } from '../../db/schema/index.js';
import { lockTask, type CommandContext, type HandlerOutcome } from '../context.js';
import { calendarTimeZone, requireActive, requireLeaf } from '../entities.js';
import { updateRow, updateWhere } from '../journal.js';
import { toInstant, toIso } from '../../schedule/instants.js';
import type {
  CancelTaskParams,
  ExtendTaskParams,
  MoveToBacklogParams,
  PromoteFromBacklogParams,
} from '@ambitime/shared';

/**
 * The rest of §7.3: a task's estimate, its cancellation, and the two commands
 * that move it across the hard-horizon boundary on purpose.
 *
 * Like every other handler, none of these writes a placement. They change what
 * the task *is* — how long, whether it still counts, which side of the horizon
 * it belongs on — and re-derivation works out what that costs the schedule.
 */

/**
 * `ExtendTask(task, new_estimate)` — the estimate was wrong (spec §7.3).
 *
 * The write is the same one `EditTask` would make, and that is fine: what
 * differs is the sentence the log ends up holding. §7.6 lists "an estimate
 * proving wrong mid-day" as a scenario the design must handle, and it is
 * handled by changing the duration and re-deriving — the task grows, and
 * everything downstream of it reflows to make room.
 */
export async function extendTask(
  params: ExtendTaskParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);
  await requireLeaf(ctx, task);

  await updateRow(ctx, 'tasks', task.id, { estimatedDurationMin: params.newEstimateMin });

  return { calendarIds: [task.calendarId] };
}

/**
 * `CancelTask(task)` — not doing this (spec §7.3).
 *
 * **Cascades to the subtree**, unlike the other single-task actions, which
 * refuse a parent. The difference is that they set a floor, which is not an
 * inheritable property and would sit unread on a branch; cancelling is a status,
 * and §4.4 already has a parent's completion roll up from its children. "Free
 * its footprint" for a branch can only mean the footprint of its leaves, since
 * a branch has none of its own.
 *
 * The footprint is freed by re-derivation rather than by deleting anything: a
 * cancelled task is not active, so it is not loaded as demand, so the recomputed
 * cache does not contain it. The row stays, because a cancelled task is a thing
 * the user may want to look at — and undo restores it in one step.
 */
export async function cancelTask(
  params: CancelTaskParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);

  const subtree = await subtreeIds(ctx, task.id);

  await updateWhere(ctx, 'tasks', and(inArray(tasks.id, subtree), eq(tasks.status, 'active'))!, {
    status: 'cancelled',
  });

  // Only pending ones. A child completed last week happened, and cancelling its
  // parent does not un-happen it.
  await updateWhere(
    ctx,
    'task_occurrences',
    and(inArray(taskOccurrences.taskId, subtree), eq(taskOccurrences.status, 'pending'))!,
    { status: 'cancelled' },
  );

  return { calendarIds: [task.calendarId] };
}

/**
 * `MoveToBacklog(task)` — "not this fortnight" (spec §7.3).
 *
 * Floors the task at the end of the hard horizon, which is not a special case
 * anywhere: nothing can be placed past the horizon, so the coarse weekly planner
 * picks the task up and gives it an estimated week (§6.1).
 *
 * Deliberately **not** a deferral: `defer_count` is untouched. §7.3 gives the
 * increment to `DeferTask` alone, and the two commands differ in exactly that
 * respect — `DeferTask(backlog)` is "I keep not doing this", a horizon decision
 * is "this belongs later". Counting the second would fire §6.6's chronic-
 * postponement notification at users who are planning rather than avoiding.
 */
export async function moveToBacklog(
  params: MoveToBacklogParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);
  await requireLeaf(ctx, task);

  const horizon = await horizonFor(ctx, task.calendarId);

  await updateRow(ctx, 'tasks', task.id, {
    manualFloor: toIso(horizon.end),
    manualBias: null,
  });

  return { calendarIds: [task.calendarId] };
}

/**
 * `PromoteFromBacklog(task)` — the other direction (spec §7.3).
 *
 * Clears the floor that was holding the task out, and only that floor: one
 * pointing *inside* the horizon is a reposition the user made for their own
 * reasons and is not what put the task in the backlog, so discarding it would
 * throw away an instruction the command was never asked about.
 *
 * A task backlogged for want of capacity rather than by a floor is promoted to
 * *eligible*, not to placed — whether it fits is the solver's call, and the
 * derived schedule the command returns says which happened. The alternative
 * would be evicting some other task without being able to say which.
 */
export async function promoteFromBacklog(
  params: PromoteFromBacklogParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);
  await requireLeaf(ctx, task);

  const horizon = await horizonFor(ctx, task.calendarId);

  if (task.manualFloor !== null && toInstant(task.manualFloor) >= horizon.end) {
    await updateRow(ctx, 'tasks', task.id, { manualFloor: null });
  }

  return { calendarIds: [task.calendarId] };
}

async function horizonFor(ctx: CommandContext, calendarId: string) {
  const timeZone = await calendarTimeZone(ctx, calendarId);
  return computeHardHorizon(ctx.now, timeZone, ctx.config);
}

/**
 * A task and everything under it.
 *
 * Depth is capped at 5 (§4.4), so the recursion is bounded to five levels and a
 * plain adjacency walk is cheaper than any of the alternatives the cap exists to
 * avoid. RLS scopes it to the tenant, as it does every other read here.
 */
async function subtreeIds(ctx: CommandContext, rootId: string): Promise<string[]> {
  const rows = await ctx.tx.execute<{ id: string }>(sql`
    with recursive subtree as (
      select t.id from tasks t where t.id = ${rootId}
      union all
      select child.id
      from tasks child
      join subtree on child.parent_id = subtree.id
    )
    select id from subtree
  `);

  return [...rows].map((row) => row.id);
}
