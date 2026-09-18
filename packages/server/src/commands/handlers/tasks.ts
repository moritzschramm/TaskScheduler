import { eq } from 'drizzle-orm';
import { lockTask, type CommandContext, type HandlerOutcome } from '../context.js';
import {
  createInitialOccurrence,
  pendingOccurrenceId,
  requireActive,
  requireCalendar,
  retirePendingOccurrences,
} from '../entities.js';
import { PreconditionFailedError } from '../errors.js';
import { insertRow, updateRow } from '../journal.js';
import { tasks } from '../../db/schema/index.js';
import type { CreateTaskParams, EditTaskParams, SetTaskParentParams } from '@ambitime/shared';
import type { NewTask } from '../../db/schema/index.js';

/**
 * Creating and editing tasks — the ordinary write path (spec §4.4, §7).
 *
 * Neither command touches a placement. A task's schedule is derived from its
 * constraints, so creating an urgent task for today and editing an estimate
 * mid-morning are the same kind of act: change the source, re-derive, see where
 * things land (§7.6).
 */

export async function createTask(
  params: CreateTaskParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  await requireCalendar(ctx, params.calendarId);

  const values: NewTask = {
    tenantId: ctx.tenantId,
    calendarId: params.calendarId,
    // The actor owns what they create. Spec §10.2 keeps `owner` on every
    // resource so a relationship-based model stays additive later.
    ownerId: ctx.actorId,
    title: params.title,
    notes: params.notes,
    parentId: params.parentId,
    activityTypeId: params.activityTypeId,
    estimatedDurationMin: params.estimatedDurationMin,
    priority: params.priority,
    dueDate: params.dueDate?.date,
    dueKind: params.dueDate?.kind,
    preferredStartMin: params.preferredRange?.startMin,
    preferredEndMin: params.preferredRange?.endMin,
    preferredWeekdays: params.preferredWeekdays,
    focusLevel: params.focusLevel,
    cooldownOverrideMin: params.cooldownOverrideMin,
    sequenceId: params.sequenceId,
    sequencePosition: params.sequencePosition,
    recurrencePeriod: params.recurrence?.period,
    recurrenceCount: params.recurrence?.count,
    ...(params.recurrence?.missedPolicy === undefined
      ? {}
      : { missedOccurrencePolicy: params.recurrence.missedPolicy }),
  };

  const taskId = await insertRow(ctx, 'tasks', values);

  // A brand-new task is a leaf, so it is demand and gets its occurrence. If it
  // was created beneath another task, that other task has just stopped being
  // one.
  //
  // A *recurring* task gets none here: its demand is per period and belongs to
  // the generator (§8.2). One period-less occurrence beside the periodic ones
  // would be an extra unit of work nobody asked for, and no period would bound
  // where it went.
  if (params.recurrence === undefined) await createInitialOccurrence(ctx, taskId);
  if (params.parentId !== undefined) await retirePendingOccurrences(ctx, params.parentId);

  return { calendarIds: [params.calendarId] };
}

export async function editTask(
  params: EditTaskParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  const { patch } = params;
  const values: Partial<NewTask> = {};

  // `undefined` means the patch says nothing about this field; `null` means the
  // user dropped their override and wants the ancestor's value back (§4.4).
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.activityTypeId !== undefined) values.activityTypeId = patch.activityTypeId;
  if (patch.estimatedDurationMin !== undefined) {
    values.estimatedDurationMin = patch.estimatedDurationMin;
  }
  if (patch.priority !== undefined) values.priority = patch.priority;
  if (patch.focusLevel !== undefined) values.focusLevel = patch.focusLevel;
  if (patch.cooldownOverrideMin !== undefined) {
    values.cooldownOverrideMin = patch.cooldownOverrideMin;
  }

  // `null` stops the task recurring; a rule starts or changes it. The
  // occurrences follow on the next generation pass rather than being rewritten
  // here — what a period should contain is one decision, made in one place.
  if (patch.recurrence !== undefined) {
    values.recurrencePeriod = patch.recurrence?.period ?? null;
    values.recurrenceCount = patch.recurrence?.count ?? null;
    if (patch.recurrence?.missedPolicy !== undefined) {
      values.missedOccurrencePolicy = patch.recurrence.missedPolicy;
    }
  }

  // The paired fields move together or not at all, which is what keeps the
  // `tasks_due_pair` and `tasks_preferred_range_valid` constraints satisfiable
  // by construction rather than by the caller being careful.
  if (patch.dueDate !== undefined) {
    values.dueDate = patch.dueDate?.date ?? null;
    values.dueKind = patch.dueDate?.kind ?? null;
  }
  if (patch.preferredRange !== undefined) {
    values.preferredStartMin = patch.preferredRange?.startMin ?? null;
    values.preferredEndMin = patch.preferredRange?.endMin ?? null;
  }
  // Not paired with the range: either half of "Tuesdays in the afternoon" can
  // be cleared without touching the other (migration 0021).
  if (patch.preferredWeekdays !== undefined) {
    values.preferredWeekdays = patch.preferredWeekdays;
  }

  await updateRow(ctx, 'tasks', task.id, values);

  return { calendarIds: [task.calendarId] };
}

/**
 * `SetTaskParent(task, parent)` — move a task and its subtree (spec §4.4).
 *
 * Almost all of this is already in the database. Migration 0004's
 * `tasks_enforce_hierarchy` fires on UPDATE as well as INSERT, so the cycle
 * check and the depth cap apply to a move without being restated here, and
 * `tasks_resync_subtree_depth` re-depths the descendants that travel with it —
 * a move that would push any of them past depth 5 is rejected by the
 * `tasks_depth_range` CHECK. The deferred due-date trigger re-checks the
 * subtree at commit, which is what catches a task moving under a container that
 * is due sooner than it is.
 *
 * What is left is the *occurrences*, and it is the half a database constraint
 * cannot express. A task is a unit of demand only while it is a leaf (§4.4), so
 * a move changes two other tasks' minds about themselves:
 *
 * - the new parent has stopped being a leaf, and its pending occurrence would
 *   otherwise sit in the schedule competing with its own children for time;
 * - the old parent may have become one again, and it lost its occurrence when
 *   it first gained a child. Without a new one it would be a task with an
 *   estimate, no children, and nothing anywhere representing it — invisible to
 *   the solver *and* to the "not being scheduled" list, which is the worst of
 *   both.
 *
 * Within one calendar only. A task carries its own `calendar_id`, so moving
 * across calendars means rewriting the subtree's and re-deriving two schedules
 * — a different, larger command, and not one anybody has asked for.
 */
export async function setTaskParent(
  params: SetTaskParentParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const task = await lockTask(ctx, params.taskId);
  requireActive(task);

  if (params.parentId === task.id) {
    throw new PreconditionFailedError('A task cannot be its own parent');
  }

  const previousParentId = task.parentId;
  if (params.parentId === previousParentId) return { calendarIds: [task.calendarId] };

  if (params.parentId !== null) {
    const parent = await lockTask(ctx, params.parentId);
    requireActive(parent);

    if (parent.calendarId !== task.calendarId) {
      throw new PreconditionFailedError(
        `Task ${task.id} and task ${parent.id} are in different planners; a task moves within one`,
      );
    }
  }

  await updateRow(ctx, 'tasks', task.id, { parentId: params.parentId });

  if (params.parentId !== null) await retirePendingOccurrences(ctx, params.parentId);
  if (previousParentId !== null) await restoreLeafOccurrence(ctx, previousParentId);

  return { calendarIds: [task.calendarId] };
}

/**
 * Gives a task its occurrence back if the move left it childless.
 *
 * Only then: a parent that still has other children is still a container, and a
 * recurring one gets its occurrences from the generator per period rather than
 * from here (§8.2). The existing-occurrence check is not defensive — a task
 * whose children were all cancelled rather than moved still has none, since
 * `retirePendingOccurrences` deletes — but it costs one query and makes the
 * function safe to call from anywhere that ends up in this state.
 */
async function restoreLeafOccurrence(ctx: CommandContext, taskId: string): Promise<void> {
  const [child] = await ctx.tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentId, taskId))
    .limit(1);
  if (child) return;

  const [parent] = await ctx.tx
    .select({ status: tasks.status, recurrencePeriod: tasks.recurrencePeriod })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!parent || parent.status !== 'active' || parent.recurrencePeriod !== null) return;

  if ((await pendingOccurrenceId(ctx, taskId)) === undefined) {
    await createInitialOccurrence(ctx, taskId);
  }
}
