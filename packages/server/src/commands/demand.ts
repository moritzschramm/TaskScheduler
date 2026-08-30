import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  formatCivilDate,
  instantToZonedCivil,
  localDay,
  localMonth,
  localWeek,
  toCivilDate,
  type Instant,
  type Interval,
  type TuningConfig,
} from '@ambitime/scheduler';
import { taskOccurrences, tasks } from '../db/schema/index.js';
import { insertRow, updateWhere } from './journal.js';
import type { CommandContext } from './context.js';

/**
 * The per-period demand generator (spec §8.2).
 *
 * A recurring task is a **demand rule**, not a datetime rule: "exercise 3× per
 * week" says how much a period should contain and nothing about when. So this
 * spawns occurrences per period and stops — where each one goes is the
 * scheduler's business, placed flexibly within its category like any other
 * demand. Nothing here computes a time.
 *
 * That separation is the point of §8: an appointment's recurrence expands a
 * rule into fixed datetimes, and the two mechanisms must not be collapsed into
 * one however alike they look in a UI. There is no code in common between them
 * and there should not be.
 *
 * Runs on the **write path**, before the derive that follows a command. A
 * period that begins while nobody is looking therefore has no occurrences until
 * the next command touches the calendar; noticing the passage of time on its
 * own is a job, and jobs are M15 (§11).
 */

/** How far ahead demand is generated: the horizon the solver can see (§6.1). */
export interface GenerateInput {
  ctx: CommandContext;
  calendarId: string;
  timeZone: string;
  horizon: Interval;
  config: TuningConfig;
}

interface RecurringTask {
  id: string;
  recurrencePeriod: 'day' | 'week' | 'month';
  recurrenceCount: number;
  missedOccurrencePolicy: 'rollover' | 'expire';
}

interface Period {
  start: string;
  end: string;
  interval: Interval;
}

export async function generateDemand({
  ctx,
  calendarId,
  timeZone,
  horizon,
  config,
}: GenerateInput): Promise<void> {
  const recurring = await loadRecurringTasks(ctx, calendarId);
  if (recurring.length === 0) return;

  for (const task of recurring) {
    const periods = periodsOver(task.recurrencePeriod, horizon, timeZone, config);
    await settleMissedPeriods(ctx, task, periods, timeZone, config);
    await fillPeriods(ctx, task, periods);
  }
}

async function loadRecurringTasks(
  ctx: CommandContext,
  calendarId: string,
): Promise<RecurringTask[]> {
  const rows = await ctx.tx
    .select({
      id: tasks.id,
      recurrencePeriod: tasks.recurrencePeriod,
      recurrenceCount: tasks.recurrenceCount,
      missedOccurrencePolicy: tasks.missedOccurrencePolicy,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.calendarId, calendarId),
        eq(tasks.status, 'active'),
        isNotNull(tasks.recurrencePeriod),
        // Only leaves are placed (§4.4), so only leaves are demand. A parent
        // that acquired children keeps its rule and stops generating from it.
        sql`not exists (select 1 from tasks c where c.parent_id = ${tasks.id})`,
      ),
    )
    .orderBy(asc(tasks.id));

  return rows.flatMap((row) =>
    row.recurrencePeriod === null
      ? []
      : [
          {
            id: row.id,
            recurrencePeriod: row.recurrencePeriod,
            recurrenceCount: row.recurrenceCount ?? 1,
            missedOccurrencePolicy: row.missedOccurrencePolicy,
          },
        ],
  );
}

/**
 * Every period of the rule that overlaps the horizon, plus the one before it.
 *
 * The one before matters: it is the period whose unmet demand has just become
 * *missed*, and settling it is half of what this module does. Without it a
 * rollover would never fire, because the period that needs rolling over is by
 * definition the one that has already ended.
 */
function periodsOver(
  period: RecurringTask['recurrencePeriod'],
  horizon: Interval,
  timeZone: string,
  config: TuningConfig,
): Period[] {
  const bounds = (at: Instant): Interval => {
    const date = instantToZonedCivil(at, timeZone);
    if (period === 'day') return localDay(date, timeZone);
    if (period === 'week') return localWeek(date, timeZone, config);
    return localMonth(date, timeZone);
  };

  const periods: Period[] = [];
  // One step back, so the period that has just ended is settled before the
  // current one is filled.
  let cursor = bounds(horizon.start).start - 1;

  // The bound is a safety net, not a limit: a two-week horizon of daily periods
  // is about sixteen, and a runaway would mean the period arithmetic was not
  // advancing.
  for (let guard = 0; guard < 200; guard += 1) {
    const interval = bounds(cursor);
    periods.push({
      start: formatCivilDate(instantToZonedCivil(interval.start, timeZone)),
      // The last local day *inside* the period: the column is a date and the
      // interval is half-open, so the end instant belongs to the next period.
      end: formatCivilDate(instantToZonedCivil(interval.end - 1, timeZone)),
      interval,
    });

    if (interval.end >= horizon.end) break;
    cursor = interval.end;
  }

  return periods;
}

/**
 * Applies the missed-instance policy to periods that have ended (spec §8.2).
 *
 * A period is missed when it has ended and still has pending occurrences. What
 * happens next is the task's own decision, and §8.2's example is why both
 * answers exist: a missed workout should not distort the next day, while a
 * missed invoice must carry over.
 *
 * **Rollover** retires the missed occurrence and spawns a replacement in the
 * next period carrying `rolled_over_from_id`. It is not left pending in its old
 * period, because a period is what bounds its placement — an occurrence still
 * pointing at last week would be demand the solver had to place in a week that
 * has gone.
 *
 * **Expire** marks it `expired` and stops. The demand is gone, deliberately.
 */
async function settleMissedPeriods(
  ctx: CommandContext,
  task: RecurringTask,
  periods: readonly Period[],
  timeZone: string,
  config: TuningConfig,
): Promise<void> {
  const ended = periods.filter((period) => period.interval.end <= ctx.now);
  if (ended.length === 0) return;

  const missed = await ctx.tx
    .select({ id: taskOccurrences.id, periodStart: taskOccurrences.periodStart })
    .from(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, task.id),
        eq(taskOccurrences.status, 'pending'),
        inArray(
          taskOccurrences.periodStart,
          ended.map((period) => period.start),
        ),
      ),
    )
    .orderBy(asc(taskOccurrences.id));

  if (missed.length === 0) return;

  await updateWhere(
    ctx,
    'task_occurrences',
    inArray(
      taskOccurrences.id,
      missed.map((row) => row.id),
    ),
    { status: 'expired' },
  );

  if (task.missedOccurrencePolicy === 'expire') return;

  for (const row of missed) {
    if (row.periodStart === null) continue;
    const next = nextPeriodOf(row.periodStart, task.recurrencePeriod, timeZone, config);

    await insertRow(ctx, 'task_occurrences', {
      tenantId: ctx.tenantId,
      taskId: task.id,
      periodStart: next.start,
      periodEnd: next.end,
      rolledOverFromId: row.id,
    });
  }
}

/** The period following the one starting on `periodStart`. */
function nextPeriodOf(
  periodStart: string,
  period: RecurringTask['recurrencePeriod'],
  timeZone: string,
  config: TuningConfig,
): Period {
  const bounds = (date: ReturnType<typeof toCivilDate>): Interval => {
    if (period === 'day') return localDay(date, timeZone);
    if (period === 'week') return localWeek(date, timeZone, config);
    return localMonth(date, timeZone);
  };

  const current = bounds(toCivilDate(periodStart));
  const next = bounds(instantToZonedCivil(current.end, timeZone));

  return {
    start: formatCivilDate(instantToZonedCivil(next.start, timeZone)),
    end: formatCivilDate(instantToZonedCivil(next.end - 1, timeZone)),
    interval: next,
  };
}

/**
 * Tops each live period up to the task's count.
 *
 * Counts what is *there* rather than what was created: an occurrence completed
 * this week still satisfies this week's demand, and a rolled-over one counts
 * towards the period it landed in. Spawning to a target rather than on a
 * schedule is what makes this idempotent — every command re-runs it, and only a
 * shortfall produces a row.
 */
async function fillPeriods(
  ctx: CommandContext,
  task: RecurringTask,
  periods: readonly Period[],
): Promise<void> {
  const live = periods.filter((period) => period.interval.end > ctx.now);
  if (live.length === 0) return;

  const existing = await ctx.tx
    .select({ periodStart: taskOccurrences.periodStart, count: sql<number>`count(*)::int` })
    .from(taskOccurrences)
    .where(
      and(
        eq(taskOccurrences.taskId, task.id),
        inArray(
          taskOccurrences.periodStart,
          live.map((period) => period.start),
        ),
        // Cancelled and expired demand is gone; it does not count as met.
        inArray(taskOccurrences.status, ['pending', 'completed']),
      ),
    )
    .groupBy(taskOccurrences.periodStart);

  const held = new Map(existing.map((row) => [row.periodStart, row.count]));

  for (const period of live) {
    const shortfall = task.recurrenceCount - (held.get(period.start) ?? 0);

    for (let index = 0; index < shortfall; index += 1) {
      await insertRow(ctx, 'task_occurrences', {
        tenantId: ctx.tenantId,
        taskId: task.id,
        periodStart: period.start,
        periodEnd: period.end,
      });
    }
  }
}
