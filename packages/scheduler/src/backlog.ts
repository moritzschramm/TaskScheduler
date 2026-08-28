import { byId, byInt, chain, sorted } from './ordering.js';
import { formatCivilDate, planningWeeksAfter, type PlanningWeek } from './horizon.js';
import type { TuningConfig } from './config.js';
import type { InfeasibilityReason } from './diagnostics.js';
import type { PlacementUnit } from './sequences.js';
import type { ResolvedWindow, ScheduleContext } from './types.js';

/**
 * The coarse weekly planner (spec §6.1).
 *
 * Beyond the hard horizon there are no datetimes, only weeks: a backlog task is
 * shown as "likely week X", not a specific slot. The planner is the same idea
 * as the placer at a coarser grain — bin-pack the remaining tasks into future
 * weeks by capacity and due date — which is all §6.1 asks for.
 *
 * Packing is per **unit**, not per task, so an uninterruptible sequence is
 * estimated into one week as a block. Splitting a sequence across two estimated
 * weeks would promise something rule 5 forbids.
 *
 * Capacity proper, with the contiguity check, is §6.6 and lives in
 * `capacity.ts`. What is used here is the simplest defensible supply estimate:
 * the window minutes a category has in a typical week.
 */

export interface BacklogEntry {
  occurrenceId: string;
  /**
   * Week start date as `YYYY-MM-DD`, matching the `estimated_week` column, or
   * `null` when the task does not fit anywhere in the planning window.
   */
  estimatedWeek: string | null;
  reason: InfeasibilityReason;
  /** Set when the entry is a sequence member, so callers can group them. */
  sequenceId?: string;
}

/** A unit the solver could not place, and why. */
export interface UnplacedUnit {
  unit: PlacementUnit;
  reason: InfeasibilityReason;
}

/**
 * Reasons for which no future week can honestly be estimated.
 *
 * Each is a fact about the *shape* of the calendar rather than about how full
 * this particular fortnight is, so waiting will not help and naming a week
 * would be a promise the planner cannot keep. Saying "no week" is the more
 * useful answer: it points at configuration, which is where the fix is.
 */
const UNESTIMABLE: ReadonlySet<InfeasibilityReason> = new Set<InfeasibilityReason>([
  'no_feasible_window',
  'no_contiguous_span',
  'sequence_members_incompatible',
]);

/**
 * Assigns each unplaced unit an estimated week, then spreads it to its members.
 *
 * Units are packed in due-date order so deadlines get the earliest weeks, with
 * the unit id as a final tie-break to keep the result total (spec §6.3).
 */
export function assignBacklogWeeks(
  unplaced: readonly UnplacedUnit[],
  context: ScheduleContext,
  config: TuningConfig,
): BacklogEntry[] {
  if (unplaced.length === 0) return [];

  const timeZone = context.calendars[0]?.timeZone ?? 'UTC';
  const weeks = planningWeeksAfter(context.horizon, timeZone, config);
  const weeklySupply = weeklySupplyByCategory(context.windows, context.horizon);

  // Remaining capacity per (category, week). A week starts with the category's
  // typical weekly supply and is drawn down as units are assigned to it.
  const remaining = new Map<string, number>();
  const capacityFor = (categoryKey: string, weekIndex: number): number => {
    const key = `${categoryKey}@${weekIndex}`;
    if (!remaining.has(key)) remaining.set(key, weeklySupply.get(categoryKey) ?? 0);
    return remaining.get(key)!;
  };

  const ordered = sorted(
    unplaced,
    chain<UnplacedUnit>(
      byInt((entry) => entry.unit.composite.dueDate ?? Number.MAX_SAFE_INTEGER),
      byId((entry) => entry.unit.id),
    ),
  );

  const entries: BacklogEntry[] = [];
  for (const entry of ordered) {
    const estimatedWeek = firstFittingWeek(entry, weeks, capacityFor, remaining);

    for (const { schedulable } of entry.unit.members) {
      entries.push({
        occurrenceId: schedulable.occurrenceId,
        reason: entry.reason,
        estimatedWeek,
        ...(entry.unit.sequenceId === undefined ? {} : { sequenceId: entry.unit.sequenceId }),
      });
    }
  }

  return entries;
}

/**
 * The earliest planning week with room for this unit, honouring its constraints.
 *
 * A manual floor or a hard due date narrows which weeks are even eligible
 * before capacity is considered — placing a unit in a week that ends after its
 * hard deadline would be a worse answer than admitting it does not fit.
 */
function firstFittingWeek(
  entry: UnplacedUnit,
  weeks: readonly PlanningWeek[],
  capacityFor: (categoryKey: string, weekIndex: number) => number,
  remaining: Map<string, number>,
): string | null {
  if (UNESTIMABLE.has(entry.reason)) return null;

  const { composite } = entry.unit;
  const categoryKey = `${composite.calendarId} ${composite.categoryId}`;
  const footprint = composite.durationMin + composite.cooldownMin;

  for (let index = 0; index < weeks.length; index += 1) {
    const week = weeks[index]!;

    if (composite.manualFloor !== undefined && week.interval.end <= composite.manualFloor) {
      continue;
    }
    if (
      composite.dueKind === 'hard' &&
      composite.dueDate !== undefined &&
      week.interval.start >= composite.dueDate
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
