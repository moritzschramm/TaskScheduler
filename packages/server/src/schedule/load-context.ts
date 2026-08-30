import { and, eq, gt, lt, ne, sql } from 'drizzle-orm';
import {
  computeHardHorizon,
  resolveWindows,
  type AvailabilityRule,
  type CalendarSpec,
  type FixedBlock,
  type Instant,
  type Interval,
  type Schedulable,
  type ScheduleContext,
  type SequenceSpec,
  type TuningConfig,
  type WeekdayRange,
  type WeekTypeOverride,
} from '@ambitime/scheduler';
import {
  appointments,
  availabilityWindows,
  calendars,
  calendarWindows,
  categories,
  sequences,
  taskOccurrences,
  tasks,
  weekTypeOverrides,
} from '../db/schema/index.js';
import { readCalendarTaskTree, type TaskTreeNode } from '../tasks/task-tree.js';
import { isoText, toCivilDate, toInstant, toInstantCeil } from './instants.js';
import { localDay } from '@ambitime/scheduler';
import type { Transaction } from '../db/client.js';

/**
 * Reads one calendar's world out of the database and into the shape the
 * scheduler takes (spec §3.3).
 *
 * The engine is a pure function of plain data; this is the impure half that
 * gathers it. Keeping the two apart is what lets the identical solver run in a
 * browser for an optimistic schedule and on the server for the authoritative
 * one — the client will build the same `ScheduleContext` from its own store.
 *
 * Everything here runs inside the caller's transaction, so RLS scopes it to the
 * active tenant (§5.2). No query filters on `tenant_id` itself: doing that by
 * hand would make the policies look redundant and invite someone to drop them.
 */

/** A leaf the solver was never offered, because it is not yet schedulable. */
export interface UnschedulableTask {
  taskId: string;
  occurrenceId: string;
  reason: 'no_category' | 'no_duration';
}

export interface ScheduleContextResult {
  context: ScheduleContext;
  unschedulable: UnschedulableTask[];
}

export interface LoadContextInput {
  tx: Transaction;
  calendarId: string;
  /** Explicit, never read from a clock here or below (spec §6.3). */
  now: Instant;
  config: TuningConfig;
}

/**
 * The part of the hard horizon a task may actually be placed in.
 *
 * §6.1 puts the horizon at the current week plus the next, and §6.2 does not
 * list "not in the past" among the hard constraints — but §7 assumes it
 * throughout: `PostponeRestOfDay` moves what is on a day "from `now` forward",
 * `CompleteTask` re-derives "the remainder of the day", and finishing early
 * "pulls the day forward". A schedule offering Monday 09:00 on Wednesday
 * afternoon is not one any of those sentences describes.
 *
 * The clip is made here rather than in the engine on purpose. The solver is a
 * pure function of its inputs and the horizon is one of them, so *what is
 * placeable* is the caller's decision — which also leaves a client free to
 * re-solve a past week for a what-if without a special mode in the solver.
 *
 * Only the start moves. The end still marks where the coarse weekly planner
 * takes over (§6.1).
 */
function placeableHorizon(now: Instant, timeZone: string, config: TuningConfig): Interval {
  const horizon = computeHardHorizon(now, timeZone, config);
  return { start: Math.max(horizon.start, now), end: horizon.end };
}

export class CalendarNotFoundError extends Error {
  constructor(readonly calendarId: string) {
    super(`Calendar ${calendarId} does not exist in this context`);
    this.name = 'CalendarNotFoundError';
  }
}

export async function loadScheduleContext({
  tx,
  calendarId,
  now,
  config,
}: LoadContextInput): Promise<ScheduleContextResult> {
  const [calendar] = await tx
    .select({ id: calendars.id, timeZone: calendars.timezone })
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .limit(1);

  // RLS makes "not visible in this tenant" and "does not exist" the same
  // answer, which is the answer a caller should get either way.
  if (!calendar) throw new CalendarNotFoundError(calendarId);

  const workingWindow = await loadWorkingWindow(tx, calendarId);
  const spec: CalendarSpec = {
    id: calendar.id,
    timeZone: calendar.timeZone,
    // Omitted rather than passed empty when unset: to the engine, absent means
    // unrestricted and `[]` means nothing may be placed (§9.1).
    ...(workingWindow === undefined ? {} : { workingWindow }),
  };
  const horizon = placeableHorizon(now, spec.timeZone, config);

  const [rules, overrides, fixedBlocks, sequenceSpecs, demand] = await Promise.all([
    loadAvailabilityRules(tx, calendarId),
    loadWeekTypeOverrides(tx, calendarId, horizon),
    loadFixedBlocks(tx, calendarId, horizon),
    loadSequences(tx, calendarId),
    loadDemand(tx, calendarId, spec.timeZone),
  ]);

  return {
    context: {
      now,
      horizon,
      calendars: [spec],
      schedulables: demand.schedulables,
      fixedBlocks,
      windows: resolveWindows({ horizon, calendars: [spec], rules, overrides }),
      sequences: sequenceSpecs,
    },
    unschedulable: demand.unschedulable,
  };
}

/**
 * The calendar's working window (spec §9.1) — when the scheduler may place at
 * all, as distinct from when a category is available.
 *
 * Returns `undefined` for a calendar with no rows, because a working window
 * that was never configured restricts nothing. Reading zero rows as "no working
 * time" would make every calendar unschedulable until somebody visited a
 * settings screen.
 *
 * The shareable window (§9.2) shares this table and is deliberately not read
 * here: it governs what *other users* see, not where this calendar's own work
 * may go.
 */
async function loadWorkingWindow(
  tx: Transaction,
  calendarId: string,
): Promise<WeekdayRange[] | undefined> {
  const rows = await tx
    .select({
      weekday: calendarWindows.weekday,
      startMin: calendarWindows.startMin,
      endMin: calendarWindows.endMin,
    })
    .from(calendarWindows)
    .where(and(eq(calendarWindows.calendarId, calendarId), eq(calendarWindows.kind, 'working')));

  return rows.length === 0 ? undefined : rows;
}

async function loadAvailabilityRules(
  tx: Transaction,
  calendarId: string,
): Promise<AvailabilityRule[]> {
  const rows = await tx
    .select({
      id: availabilityWindows.id,
      calendarId: availabilityWindows.calendarId,
      categoryId: availabilityWindows.categoryId,
      weekTypeOverrideId: availabilityWindows.weekTypeOverrideId,
      weekday: availabilityWindows.weekday,
      startMin: availabilityWindows.startMin,
      endMin: availabilityWindows.endMin,
      focusLevel: availabilityWindows.focusLevel,
    })
    .from(availabilityWindows)
    .where(eq(availabilityWindows.calendarId, calendarId));

  return rows.map((row) => ({
    id: row.id,
    calendarId: row.calendarId,
    categoryId: row.categoryId,
    weekday: row.weekday,
    startMin: row.startMin,
    endMin: row.endMin,
    // Absent rather than null: `exactOptionalPropertyTypes` keeps "no override"
    // and "an override that is undefined" from being confusable.
    ...(row.weekTypeOverrideId === null ? {} : { weekTypeOverrideId: row.weekTypeOverrideId }),
    ...(row.focusLevel === null ? {} : { focusLevel: row.focusLevel }),
  }));
}

async function loadWeekTypeOverrides(
  tx: Transaction,
  calendarId: string,
  horizon: { start: Instant; end: Instant },
): Promise<WeekTypeOverride[]> {
  // Dates are local and the horizon is in instants, so the comparison is
  // deliberately loose by a day at each end; `resolveWindows` decides which
  // override actually governs a date.
  const from = sql`(to_timestamp(${horizon.start * 60}) - interval '1 day')::date`;
  const to = sql`(to_timestamp(${horizon.end * 60}) + interval '1 day')::date`;

  const rows = await tx
    .select({
      id: weekTypeOverrides.id,
      calendarId: weekTypeOverrides.calendarId,
      startDate: weekTypeOverrides.startDate,
      endDate: weekTypeOverrides.endDate,
    })
    .from(weekTypeOverrides)
    .where(
      and(
        eq(weekTypeOverrides.calendarId, calendarId),
        lt(weekTypeOverrides.startDate, to),
        gt(weekTypeOverrides.endDate, from),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    calendarId: row.calendarId,
    startDate: toCivilDate(row.startDate),
    endDate: toCivilDate(row.endDate),
  }));
}

/**
 * Appointments overlapping the horizon (spec §6.2 rule 2, §7.4).
 *
 * A cancelled appointment stops reserving time — that is the whole point of
 * cancelling one. Unavailability blocks are included without distinction: the
 * engine does not care why a block is there, only that it is (§7.4).
 */
async function loadFixedBlocks(
  tx: Transaction,
  calendarId: string,
  horizon: { start: Instant; end: Instant },
): Promise<FixedBlock[]> {
  const rows = await tx
    .select({
      id: appointments.id,
      startAt: isoText(sql`lower(${appointments.during})`),
      endAt: isoText(sql`upper(${appointments.during})`),
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.calendarId, calendarId),
        ne(appointments.status, 'cancelled'),
        sql`${appointments.during} && tstzrange(to_timestamp(${horizon.start * 60}), to_timestamp(${horizon.end * 60}), '[)')`,
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    calendarId,
    // Outward: a fixed block never shrinks because of sub-minute endpoints.
    interval: { start: toInstant(row.startAt), end: toInstantCeil(row.endAt) },
  }));
}

async function loadSequences(tx: Transaction, calendarId: string): Promise<SequenceSpec[]> {
  const rows = await tx
    .select({ id: sequences.id, isOrdered: sequences.isOrdered })
    .from(sequences)
    .where(eq(sequences.calendarId, calendarId));

  return rows.map((row) => ({ id: row.id, isOrdered: row.isOrdered }));
}

interface DemandRow {
  occurrenceId: string;
  taskId: string;
  manualFloor: string | null;
  manualBias: string | null;
  sequenceId: string | null;
  sequencePosition: number | null;
  /** The period a recurring occurrence belongs to (§8.2); both null otherwise. */
  periodStart: string | null;
  periodEnd: string | null;
}

/**
 * The units of demand: one `Schedulable` per pending occurrence of an active
 * leaf task (spec §4.3, §4.4).
 *
 * Inherited properties come from the recursive-CTE tree read, which resolves
 * nearest-ancestor-wins in one pass. The occurrence query supplies what is
 * *not* inheritable — a manual floor is this task's, not its parent's — and the
 * two are joined here on the task id.
 */
async function loadDemand(
  tx: Transaction,
  calendarId: string,
  calendarTimeZone: string,
): Promise<{ schedulables: Schedulable[]; unschedulable: UnschedulableTask[] }> {
  const [tree, rows, cooldowns] = await Promise.all([
    readCalendarTaskTree(tx, calendarId),
    tx
      .select({
        occurrenceId: taskOccurrences.id,
        taskId: taskOccurrences.taskId,
        manualFloor: tasks.manualFloor,
        manualBias: tasks.manualBias,
        periodStart: taskOccurrences.periodStart,
        periodEnd: taskOccurrences.periodEnd,
        sequenceId: tasks.sequenceId,
        sequencePosition: tasks.sequencePosition,
      })
      .from(taskOccurrences)
      .innerJoin(tasks, eq(tasks.id, taskOccurrences.taskId))
      .where(
        and(
          eq(tasks.calendarId, calendarId),
          eq(tasks.status, 'active'),
          eq(taskOccurrences.status, 'pending'),
        ),
      ),
    loadCategoryCooldowns(tx),
  ]);

  const nodes = new Map(tree.map((node) => [node.id, node]));
  const schedulables: Schedulable[] = [];
  const unschedulable: UnschedulableTask[] = [];

  for (const row of rows) {
    const node = nodes.get(row.taskId);
    // A task that has acquired children is no longer a unit of work: its
    // duration and completion roll up from its leaves (§4.4).
    if (!node || !node.isLeaf) continue;

    // Neither of these is an infeasibility the solver could diagnose (§6.7):
    // the task is not hard to place, it is not yet described well enough to place.
    // Reporting them separately is what lets a UI say "this needs an estimate"
    // rather than "the week is full".
    const categoryId = node.effectiveCategoryId;
    if (categoryId === null) {
      unschedulable.push({ ...identify(row), reason: 'no_category' });
      continue;
    }

    const durationMin = node.estimatedDurationMin;
    if (durationMin === null || durationMin <= 0) {
      unschedulable.push({ ...identify(row), reason: 'no_duration' });
      continue;
    }

    schedulables.push(
      toSchedulable({
        row,
        node,
        calendarId,
        categoryId,
        durationMin,
        cooldowns,
        calendarTimeZone,
      }),
    );
  }

  return { schedulables, unschedulable };
}

async function loadCategoryCooldowns(tx: Transaction): Promise<Map<string, number>> {
  const rows = await tx
    .select({ id: categories.id, defaultCooldownMin: categories.defaultCooldownMin })
    .from(categories);

  return new Map(rows.map((row) => [row.id, row.defaultCooldownMin]));
}

function identify(row: DemandRow): { taskId: string; occurrenceId: string } {
  return { taskId: row.taskId, occurrenceId: row.occurrenceId };
}

interface SchedulableInput {
  row: DemandRow;
  node: TaskTreeNode;
  calendarId: string;
  categoryId: string;
  durationMin: number;
  cooldowns: ReadonlyMap<string, number>;
  /** The zone a period's local dates are resolved in (spec §5.1). */
  calendarTimeZone: string;
}

/** A recurring occurrence's period as instants, or `undefined` for a one-off. */
function periodBounds(row: DemandRow, timeZone: string): Interval | undefined {
  if (row.periodStart === null || row.periodEnd === null) return undefined;

  // `period_end` is the last local *day* of the period, and an interval is
  // half-open, so the bound is the start of the day after it.
  return {
    start: localDay(toCivilDate(row.periodStart), timeZone).start,
    end: localDay(toCivilDate(row.periodEnd), timeZone).end,
  };
}

function latest(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.max(...present);
}

function earliest(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

function toInstantOrUndefined(value: string | null): number | undefined {
  return value === null ? undefined : toInstant(value);
}

function toSchedulable({
  row,
  node,
  calendarId,
  categoryId,
  durationMin,
  cooldowns,
  calendarTimeZone,
}: SchedulableInput): Schedulable {
  const preferredStart = node.effectivePreferredStartMin;
  const preferredEnd = node.effectivePreferredEndMin;
  const period = periodBounds(row, calendarTimeZone);

  /**
   * A recurring occurrence's period, expressed as bounds the engine already
   * understands (spec §8.2).
   *
   * "Exercise 3× per week" means each occurrence belongs *in* its week — placed
   * flexibly, but not in some other week. That is a not-before and a
   * not-after, which is exactly what a floor and a due date are, so no new
   * engine concept is needed and the property suite is untouched.
   *
   * The period's end is **soft** even when the task's own due date is hard. A
   * period is a plan rather than a promise, and missing one is what the
   * missed-instance policy exists to handle; making it hard would turn every
   * skipped workout into an infeasibility alert.
   */
  const floor = latest(
    row.manualFloor === null ? undefined : toInstantCeil(row.manualFloor),
    period?.start,
  );
  const due = earliest(
    node.effectiveDueDate === null ? undefined : toInstant(node.effectiveDueDate),
    period?.end,
  );
  const dueKind =
    due !== undefined && due === period?.end && due !== toInstantOrUndefined(node.effectiveDueDate)
      ? ('soft' as const)
      : (node.effectiveDueKind ?? 'soft');

  return {
    occurrenceId: row.occurrenceId,
    taskId: row.taskId,
    calendarId,
    categoryId,
    durationMin,
    // The task's own override, else the category default (§6.2 rule 3). The
    // engine is given the effective value; it does not know inheritance exists.
    cooldownMin: node.effectiveCooldownOverrideMin ?? cooldowns.get(categoryId) ?? 0,
    // Inward: a deadline never moves later than what is stored.
    ...(due === undefined ? {} : { dueDate: due, dueKind }),
    // Inward again: a not-before never moves earlier than the user asked.
    ...(floor === undefined ? {} : { manualFloor: floor }),
    ...(row.manualBias === null ? {} : { manualBias: toInstant(row.manualBias) }),
    ...(row.sequenceId === null ? {} : { sequenceId: row.sequenceId }),
    ...(row.sequencePosition === null ? {} : { sequencePosition: row.sequencePosition }),
    ...(node.effectivePriority === null ? {} : { priority: node.effectivePriority }),
    ...(preferredStart === null || preferredEnd === null
      ? {}
      : { preferredRange: { startMin: preferredStart, endMin: preferredEnd } }),
    ...(node.effectiveFocusLevel === null ? {} : { focusLevel: node.effectiveFocusLevel }),
  };
}
