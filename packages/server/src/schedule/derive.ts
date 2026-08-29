import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { solve, type Instant, type SolveResult, type TuningConfig } from '@ambitime/scheduler';
import { placements, tasks } from '../db/schema/index.js';
import { loadScheduleContext, type UnschedulableTask } from './load-context.js';
import { toRangeLiteral } from './instants.js';
import type { Transaction } from '../db/client.js';

/**
 * Derived schedule state (spec §3.4).
 *
 * The minute-level schedule is **not authoritative**. Source entities plus
 * their scheduling metadata plus the command log are; this module recomputes
 * the schedule from them and writes the answer into a cache. Nothing ever edits
 * that cache in place — it is deleted and rebuilt, which is what keeps "the
 * schedule is a function of the source" true rather than aspirational.
 *
 * That is also why a manual edit does not freeze an assignment: `MoveTask`
 * changes a *constraint* on the source task, and the placement that follows is
 * whatever re-derivation makes of it (§7.3).
 */

export interface DerivedSchedule extends SolveResult {
  calendarId: string;
  /** Leaves the solver was never offered; see `UnschedulableTask`. */
  unschedulable: UnschedulableTask[];
}

export interface DeriveInput {
  tx: Transaction;
  tenantId: string;
  calendarId: string;
  /** Explicit, so a re-derive is reproducible from source alone (spec §6.3). */
  now: Instant;
  config: TuningConfig;
}

/**
 * Recomputes one calendar's schedule and replaces its cached placements.
 *
 * Runs inside the caller's transaction: a command's mutation and the schedule
 * it implies commit together or not at all, so no reader ever sees source state
 * with a stale cache beside it.
 */
export async function deriveCalendarSchedule({
  tx,
  tenantId,
  calendarId,
  now,
  config,
}: DeriveInput): Promise<DerivedSchedule> {
  const { context, unschedulable } = await loadScheduleContext({ tx, calendarId, now, config });
  const result = solve(context, { config });

  const taskByOccurrence = new Map(
    context.schedulables.map((schedulable) => [schedulable.occurrenceId, schedulable.taskId]),
  );

  await writePlacements(tx, tenantId, calendarId, result);
  await writeEstimatedWeeks(tx, calendarId, result, taskByOccurrence);

  return { ...result, calendarId, unschedulable };
}

/**
 * Replaces the calendar's cached placements wholesale.
 *
 * Deletes *everything* for the calendar rather than only the current horizon:
 * the horizon moves with `now`, so a narrower delete would leave last
 * fortnight's rows behind, and they would read as a schedule nobody derived.
 */
async function writePlacements(
  tx: Transaction,
  tenantId: string,
  calendarId: string,
  result: SolveResult,
): Promise<void> {
  await tx.delete(placements).where(eq(placements.calendarId, calendarId));

  if (result.placements.length === 0) return;

  await tx.insert(placements).values(
    result.placements.map((placement) => ({
      tenantId,
      calendarId,
      occurrenceId: placement.occurrenceId,
      during: toRangeLiteral(placement.interval),
      cooldownMin: placement.cooldownMin,
    })),
  );
}

/**
 * Writes each backlogged task's estimated week back onto the task (spec §6.1).
 *
 * This is the one derived value that lands on a source row, because that is
 * where §4.4 puts the column and where a backlog view has to read it. The
 * `IS DISTINCT FROM` guard is the point: `touch_row()` bumps `version` on any
 * real change, and `version` is what a user's optimistic lock is checked
 * against (§5.4). Without the guard every re-derive would invalidate every
 * client's held version and manufacture conflicts out of nothing. With it, a
 * schedule that did not move costs no bumps, and one that did move is a change
 * the user should be told about anyway.
 */
async function writeEstimatedWeeks(
  tx: Transaction,
  calendarId: string,
  result: SolveResult,
  taskByOccurrence: ReadonlyMap<string, string>,
): Promise<void> {
  // A task has one estimated-week column but may have several occurrences once
  // M14 lands, so the earliest week wins — the first week any of its demand is
  // expected to land in.
  const weeks = new Map<string, string>();
  for (const entry of result.backlog) {
    const taskId = taskByOccurrence.get(entry.occurrenceId);
    if (taskId === undefined || entry.estimatedWeek === null) continue;

    const existing = weeks.get(taskId);
    if (existing === undefined || entry.estimatedWeek < existing) {
      weeks.set(taskId, entry.estimatedWeek);
    }
  }

  const estimated = [...weeks.keys()];
  await tx
    .update(tasks)
    .set({ estimatedWeek: null })
    .where(
      and(
        eq(tasks.calendarId, calendarId),
        sql`${tasks.estimatedWeek} is not null`,
        ...(estimated.length === 0 ? [] : [notInArray(tasks.id, estimated)]),
      ),
    );

  for (const [week, taskIds] of groupByWeek(weeks)) {
    await tx
      .update(tasks)
      .set({ estimatedWeek: week })
      .where(and(inArray(tasks.id, taskIds), sql`${tasks.estimatedWeek} is distinct from ${week}`));
  }
}

/** One statement per distinct week, of which there are at most a dozen (§6.1). */
function groupByWeek(weeks: ReadonlyMap<string, string>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [taskId, week] of weeks) {
    const existing = grouped.get(week);
    if (existing) existing.push(taskId);
    else grouped.set(week, [taskId]);
  }
  return grouped;
}
