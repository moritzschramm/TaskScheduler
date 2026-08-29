import { lockTask, type CommandContext, type HandlerOutcome } from '../context.js';
import { createInitialOccurrence, requireCalendar, retirePendingOccurrences } from '../entities.js';
import { insertRow, updateRow } from '../journal.js';
import type { CreateTaskParams, EditTaskParams } from '@ambitime/shared';
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
    categoryId: params.categoryId,
    estimatedDurationMin: params.estimatedDurationMin,
    priority: params.priority,
    dueDate: params.dueDate?.date,
    dueKind: params.dueDate?.kind,
    preferredStartMin: params.preferredRange?.startMin,
    preferredEndMin: params.preferredRange?.endMin,
    focusLevel: params.focusLevel,
    cooldownOverrideMin: params.cooldownOverrideMin,
    sequenceId: params.sequenceId,
    sequencePosition: params.sequencePosition,
  };

  const taskId = await insertRow(ctx, 'tasks', values);

  // A brand-new task is a leaf, so it is demand and gets its occurrence. If it
  // was created beneath another task, that other task has just stopped being
  // one.
  await createInitialOccurrence(ctx, taskId);
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
  if (patch.categoryId !== undefined) values.categoryId = patch.categoryId;
  if (patch.estimatedDurationMin !== undefined) {
    values.estimatedDurationMin = patch.estimatedDurationMin;
  }
  if (patch.priority !== undefined) values.priority = patch.priority;
  if (patch.focusLevel !== undefined) values.focusLevel = patch.focusLevel;
  if (patch.cooldownOverrideMin !== undefined) {
    values.cooldownOverrideMin = patch.cooldownOverrideMin;
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

  await updateRow(ctx, 'tasks', task.id, values);

  return { calendarIds: [task.calendarId] };
}
