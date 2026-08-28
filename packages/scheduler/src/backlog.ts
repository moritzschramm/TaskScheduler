import { byId, byInt, chain, sorted } from './ordering.js';
import { formatCivilDate, planningWeeksAfter, type PlanningWeek } from './horizon.js';
import type { TuningConfig } from './config.js';
import type { InfeasibilityReason } from './diagnostics.js';
import type { ResolvedWindow, Schedulable, ScheduleContext } from './types.js';

/**
 * The coarse weekly planner (spec §6.1).
 *
 * Beyond the hard horizon there are no datetimes, only weeks: a backlog task is
 * shown as "likely week X", not a specific slot. The planner is the same idea
 * as the placer at a coarser grain — bin-pack the remaining tasks into future
 * weeks by capacity and due date — which is all §6.1 asks for.
 *
 * Capacity proper, with the contiguity check, is §6.6 and lands in M5. What is
 * used here is the simplest defensible supply estimate: the window minutes a
 * category has in a typical week.
 */

export interface BacklogEntry {
  occurrenceId: string;
  /**
   * Week start date as `YYYY-MM-DD`, matching the `estimated_week` column, or
   * `null` when the task does not fit anywhere in the planning window.
   */
  estimatedWeek: string | null;
  reason: InfeasibilityReason;
}

export interface UnplacedTask {
  schedulable: Schedulable;
  reason: InfeasibilityReason;
}

/**
 * Assigns each unplaced task an estimated week.
 *
 * Tasks are packed in due-date order so deadlines get the earliest weeks, with
 * the occurrence id as a final tie-break to keep the result total (spec §6.3).
 * A task whose category has no windows at all gets no week — there is no honest
 * estimate to give, and inventing one would be worse than saying so.
 */
export function assignBacklogWeeks(
  unplaced: readonly UnplacedTask[],
  context: ScheduleContext,
  config: TuningConfig,
): BacklogEntry[] {
  if (unplaced.length === 0) return [];

  const timeZone = context.calendars[0]?.timeZone ?? 'UTC';
  const weeks = planningWeeksAfter(context.horizon, timeZone, config);
  const weeklySupply = weeklySupplyByCategory(context.windows, context.horizon);

  // Remaining capacity per (category, week). A week starts with the category's
  // typical weekly supply and is drawn down as tasks are assigned to it.
  const remaining = new Map<string, number>();
  const capacityFor = (categoryKey: string, weekIndex: number): number => {
    const key = `${categoryKey}@${weekIndex}`;
    if (!remaining.has(key)) remaining.set(key, weeklySupply.get(categoryKey) ?? 0);
    return remaining.get(key)!;
  };

  const ordered = sorted(
    unplaced,
    chain<UnplacedTask>(
      byInt((entry) => entry.schedulable.dueDate ?? Number.MAX_SAFE_INTEGER),
      byId((entry) => entry.schedulable.occurrenceId),
    ),
  );

  return ordered.map((entry) => ({
    occurrenceId: entry.schedulable.occurrenceId,
    reason: entry.reason,
    estimatedWeek: firstFittingWeek(entry, weeks, capacityFor, remaining),
  }));
}

/**
 * The earliest planning week with room for this task, honouring its constraints.
 *
 * A manual floor or a hard due date narrows which weeks are even eligible
 * before capacity is considered — placing a task in a week that ends after its
 * hard deadline would be a worse answer than admitting it does not fit.
 */
function firstFittingWeek(
  entry: UnplacedTask,
  weeks: readonly PlanningWeek[],
  capacityFor: (categoryKey: string, weekIndex: number) => number,
  remaining: Map<string, number>,
): string | null {
  const { schedulable } = entry;

  // No windows means no supply, so no week can honestly be estimated.
  if (entry.reason === 'no_feasible_window') return null;

  const categoryKey = `${schedulable.calendarId} ${schedulable.categoryId}`;
  const footprint = schedulable.durationMin + schedulable.cooldownMin;

  for (let index = 0; index < weeks.length; index += 1) {
    const week = weeks[index]!;

    if (schedulable.manualFloor !== undefined && week.interval.end <= schedulable.manualFloor) {
      continue;
    }
    if (
      schedulable.dueKind === 'hard' &&
      schedulable.dueDate !== undefined &&
      week.interval.start >= schedulable.dueDate
    ) {
      // Every later week is later still, so there is nothing left to try.
      break;
    }

    if (capacityFor(categoryKey, index) >= footprint) {
      remaining.set(`${categoryKey}@${index}`, capacityFor(categoryKey, index) - footprint);
      return formatCivilDate(week.startDate);
    }
  }

  return null;
}

/**
 * A category's window minutes in a typical week, averaged over the horizon.
 *
 * Availability rules recur weekly, so the horizon's supply divided by its own
 * length in weeks is a fair estimate of any future week — and it needs no
 * expansion of rules past the horizon, which would cost far more than the
 * estimate is worth.
 *
 * Divided by the *actual* horizon length rather than the configured one: a
 * caller may pass a horizon of its own, and dividing real supply by an assumed
 * number of weeks would understate every future week's capacity.
 */
function weeklySupplyByCategory(
  windows: readonly ResolvedWindow[],
  horizon: { start: number; end: number },
): Map<string, number> {
  const minutesPerWeek = 7 * 24 * 60;
  const weeksInHorizon = Math.max(1, Math.round((horizon.end - horizon.start) / minutesPerWeek));

  const totals = new Map<string, number>();
  for (const window of windows) {
    const key = `${window.calendarId} ${window.categoryId}`;
    const minutes = window.interval.end - window.interval.start;
    totals.set(key, (totals.get(key) ?? 0) + minutes);
  }

  for (const [key, minutes] of totals) {
    totals.set(key, Math.floor(minutes / weeksInHorizon));
  }

  return totals;
}
