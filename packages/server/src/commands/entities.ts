import { and, eq, isNull, sql } from 'drizzle-orm';
import { calendars, taskOccurrences, tasks } from '../db/schema/index.js';
import { EntityNotFoundError, PreconditionFailedError } from './errors.js';
import { deleteWhere, insertRow } from './journal.js';
import type { CommandContext } from './context.js';
import type { Task } from '../db/schema/index.js';

/**
 * Preconditions shared by several commands (spec §7).
 *
 * Each of these could be left to a foreign key or a check constraint, and the
 * transaction would still be safe. They exist because "violates foreign key
 * constraint tasks_calendar_same_tenant_fk" is not something a user can act on,
 * and because under RLS a row in another tenant and a row that never existed
 * are indistinguishable — which is the right answer, but only if it is phrased
 * as one.
 */

export async function requireCalendar(ctx: CommandContext, calendarId: string): Promise<string> {
  const [row] = await ctx.tx
    .select({ timezone: calendars.timezone })
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .limit(1);

  if (!row) throw new EntityNotFoundError('calendar', calendarId);
  return row.timezone;
}

/** The zone a calendar's wall-clock rules and local days are resolved in (§5.1). */
export async function calendarTimeZone(ctx: CommandContext, calendarId: string): Promise<string> {
  return requireCalendar(ctx, calendarId);
}

export function requireActive(task: Task): void {
  if (task.status !== 'active') {
    throw new PreconditionFailedError(`Task ${task.id} is ${task.status}, not active`);
  }
}

/**
 * Only leaves are placed (spec §4.4): a parent's duration and completion roll
 * up from its children.
 *
 * So a manual action naming a parent has nothing to act on — `manual_floor` is
 * not one of the inheritable properties, and setting one on a parent would be
 * stored, ignored, and quietly wrong. Refusing says so.
 */
export async function requireLeaf(ctx: CommandContext, task: Task): Promise<void> {
  const [child] = await ctx.tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentId, task.id))
    .limit(1);

  if (child) {
    throw new PreconditionFailedError(
      `Task ${task.id} has subtasks; act on those instead (spec §4.4)`,
    );
  }
}

/**
 * Gives a task the occurrence that makes it a unit of demand (spec §4.3).
 *
 * Every schedulable task has at least one; a non-recurring one has exactly one,
 * with a NULL period. M14 adds rows per period rather than a branch here.
 */
export async function createInitialOccurrence(
  ctx: CommandContext,
  taskId: string,
): Promise<string> {
  return insertRow(ctx, 'task_occurrences', { tenantId: ctx.tenantId, taskId });
}

/**
 * Retires the occurrences of a task that has just become a parent.
 *
 * A branch is not a unit of work, so leaving its occurrence behind would leave
 * demand in the system that nothing represents — and its placement would sit in
 * the cache competing with its own children for time. Only *pending* ones go:
 * a completed occurrence is history, and history is not tidied up.
 */
export async function retirePendingOccurrences(ctx: CommandContext, taskId: string): Promise<void> {
  await deleteWhere(
    ctx,
    'task_occurrences',
    and(eq(taskOccurrences.taskId, taskId), eq(taskOccurrences.status, 'pending'))!,
  );
}

/** The single pending occurrence of a non-recurring task, if it still has one. */
export async function pendingOccurrenceId(
  ctx: CommandContext,
  taskId: string,
): Promise<string | undefined> {
  const [row] = await ctx.tx
    .select({ id: taskOccurrences.id })
    .from(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, taskId),
        eq(taskOccurrences.status, 'pending'),
        isNull(taskOccurrences.periodStart),
      ),
    )
    .orderBy(sql`${taskOccurrences.id}`)
    .limit(1);

  return row?.id;
}
