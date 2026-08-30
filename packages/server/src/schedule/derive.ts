import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  solve,
  type Instant,
  type ScheduleContext,
  type SolveResult,
  type TuningConfig,
} from '@ambitime/scheduler';
import { placements, tasks } from '../db/schema/index.js';
import { assertScheduleHoldsInvariants } from './commit-check.js';
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
  /** The context the schedule was derived from, for callers that enrich it. */
  context: ScheduleContext;
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

  // Spec §3.3's commit-time check, inside the transaction that is about to
  // persist the result. Today it guards the server's own output and should
  // never fire; it is here so a client-proposed schedule is a different
  // argument to the same call rather than a change to the write path.
  assertScheduleHoldsInvariants({ calendarId, context, placements: result.placements });

  const taskByOccurrence = new Map(
    context.schedulables.map((schedulable) => [schedulable.occurrenceId, schedulable.taskId]),
  );

  await writePlacements(tx, tenantId, calendarId, result);
  await writeEstimatedWeeks(tx, calendarId, result, taskByOccurrence);

  return { ...result, calendarId, unschedulable, context };
}

/**
 * Replaces the calendar's cached placements wholesale.
 *
 * Removes *everything* for the calendar that the new solve did not produce,
 * rather than only the current horizon: the horizon moves with `now`, so a
 * narrower delete would leave last fortnight's rows behind, and they would read
 * as a schedule nobody derived.
 *
 * **Upsert rather than delete-then-insert, because every read derives.** Two
 * reads of the same calendar arriving together — the week view asks for the
 * schedule and the backlog at once — each run a solve and each write the cache.
 * Under `READ COMMITTED` the second transaction's delete cannot see rows the
 * first inserted after its statement snapshot was taken, so it removed nothing
 * and then collided on `placements_occurrence_key`: a 500 on an ordinary page
 * load, whenever the timing happened to line up.
 *
 * Serialising the two with a lock on the calendar row would fix it and
 * introduce a worse problem — a read holding the calendar and wanting a task
 * row, against a command holding the task and wanting the calendar, is a
 * deadlock. Keyed writes need no lock ordering at all. The solver's output is
 * deterministic (§6.3), so two concurrent derives even take their row locks in
 * the same order.
 */
async function writePlacements(
  tx: Transaction,
  tenantId: string,
  calendarId: string,
  result: SolveResult,
): Promise<void> {
  const keep = result.placements.map((placement) => placement.occurrenceId);

  await tx
    .delete(placements)
    .where(
      keep.length === 0
        ? eq(placements.calendarId, calendarId)
        : and(eq(placements.calendarId, calendarId), notInArray(placements.occurrenceId, keep)),
    );

  if (result.placements.length === 0) return;

  await tx
    .insert(placements)
    .values(
      result.placements.map((placement) => ({
        tenantId,
        calendarId,
        occurrenceId: placement.occurrenceId,
        during: toRangeLiteral(placement.interval),
        cooldownMin: placement.cooldownMin,
      })),
    )
    .onConflictDoUpdate({
      target: placements.occurrenceId,
      set: {
        calendarId: sql`excluded.calendar_id`,
        during: sql`excluded.during`,
        cooldownMin: sql`excluded.cooldown_min`,
        // Which solve produced the row — the baseline §3.4 wants it for — so it
        // has to move even when the interval did not.
        computedAt: sql`now()`,
      },
    });
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
