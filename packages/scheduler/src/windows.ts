import {
  civilFromDays,
  daysFromCivil,
  instantToUtcDays,
  isoWeekdayFromDays,
  wallClockToInstant,
  zoneOffsetMinutes,
  type CivilDate,
  type Interval,
} from './time.js';
import { chain, byId, byInt, sorted } from './ordering.js';
import type { AvailabilityRule, CalendarSpec, ResolvedWindow, WeekTypeOverride } from './types.js';

/**
 * Expands recurring per-weekday availability rules into concrete intervals over
 * the horizon (spec §4.3, §6.2 rule 1).
 *
 * Rules are wall-clock ("Tuesdays 09:00–12:00"), so expansion happens per local
 * date in the calendar's zone. That is what makes the result correct across a
 * DST boundary: the same rule yields a different UTC instant on either side of
 * it, which is the behaviour the spec asks for (§5.1).
 */

function compareCivil(a: CivilDate, b: CivilDate): number {
  return daysFromCivil(a) - daysFromCivil(b);
}

/**
 * Which override, if any, governs a local date.
 *
 * An override *replaces* the default window set for its range (spec §4.3), so
 * at most one may apply. The spec does not say what happens when two ranges
 * overlap, and there is deliberately no database constraint preventing it, so
 * the choice is made here by a documented total order — earliest start, then id
 * — rather than left to row order (spec §6.3).
 */
function governingOverride(
  date: CivilDate,
  overrides: readonly WeekTypeOverride[],
): WeekTypeOverride | undefined {
  const covering = overrides.filter(
    (override) =>
      compareCivil(override.startDate, date) <= 0 && compareCivil(date, override.endDate) < 0,
  );

  if (covering.length === 0) return undefined;

  return sorted(
    covering,
    chain<WeekTypeOverride>(
      byInt((o) => daysFromCivil(o.startDate)),
      byId((o) => o.id),
    ),
  )[0];
}

export interface ResolveWindowsInput {
  horizon: Interval;
  calendars: readonly CalendarSpec[];
  rules: readonly AvailabilityRule[];
  overrides?: readonly WeekTypeOverride[];
}

/**
 * Produces every window instance overlapping the horizon, clipped to it.
 *
 * Output is sorted by a total order (start, end, calendar, category, rule id) so
 * two runs over the same input agree exactly — including which window the
 * validator reports a task as sitting in.
 */
export function resolveWindows({
  horizon,
  calendars,
  rules,
  overrides = [],
}: ResolveWindowsInput): ResolvedWindow[] {
  const resolved: ResolvedWindow[] = [];

  for (const calendar of calendars) {
    const calendarRules = rules.filter((rule) => rule.calendarId === calendar.id);
    if (calendarRules.length === 0) continue;

    const calendarOverrides = overrides.filter((override) => override.calendarId === calendar.id);

    // Walk local dates, not UTC days. A day is scanned either side of the
    // horizon because a local day straddles UTC midnight by up to a day's
    // offset, and a window on the far side can still reach into the horizon.
    const firstDay =
      instantToUtcDays(horizon.start + zoneOffsetMinutes(horizon.start, calendar.timeZone)) - 1;
    const lastDay =
      instantToUtcDays(horizon.end + zoneOffsetMinutes(horizon.end, calendar.timeZone)) + 1;

    for (let day = firstDay; day <= lastDay; day += 1) {
      const date = civilFromDays(day);
      const weekday = isoWeekdayFromDays(day);

      const override = governingOverride(date, calendarOverrides);
      // An override replaces the default set rather than adding to it, so the
      // two are never merged.
      const applicable = calendarRules.filter((rule) =>
        override ? rule.weekTypeOverrideId === override.id : rule.weekTypeOverrideId === undefined,
      );

      for (const rule of applicable) {
        if (rule.weekday !== weekday) continue;

        const start = wallClockToInstant(date, rule.startMin, calendar.timeZone);
        const end = wallClockToInstant(date, rule.endMin, calendar.timeZone);
        if (end <= start) continue;

        const clippedStart = Math.max(start, horizon.start);
        const clippedEnd = Math.min(end, horizon.end);
        if (clippedEnd <= clippedStart) continue;

        resolved.push({
          ruleId: rule.id,
          calendarId: rule.calendarId,
          categoryId: rule.categoryId,
          interval: { start: clippedStart, end: clippedEnd },
          ...(rule.focusLevel === undefined ? {} : { focusLevel: rule.focusLevel }),
        });
      }
    }
  }

  return sorted(resolved, compareResolvedWindows);
}

/** The total order resolved windows are always returned in. */
export const compareResolvedWindows = chain<ResolvedWindow>(
  byInt((w) => w.interval.start),
  byInt((w) => w.interval.end),
  byId((w) => w.calendarId),
  byId((w) => w.categoryId),
  byId((w) => w.ruleId),
);

/**
 * The windows a schedulable is eligible for: same calendar, same category.
 * Category membership is what spec §6.2 rule 1 turns on.
 */
export function eligibleWindows(
  windows: readonly ResolvedWindow[],
  calendarId: string,
  categoryId: string,
): ResolvedWindow[] {
  return windows.filter(
    (window) => window.calendarId === calendarId && window.categoryId === categoryId,
  );
}

/** The first eligible window wholly containing `interval`, or `undefined`. */
export function windowContaining(
  windows: readonly ResolvedWindow[],
  interval: Interval,
): ResolvedWindow | undefined {
  return windows.find(
    (window) => interval.start >= window.interval.start && interval.end <= window.interval.end,
  );
}

/** Total minutes of window time available to a category, for capacity work in M5. */
export function totalWindowMinutes(windows: readonly ResolvedWindow[]): number {
  return windows.reduce((sum, window) => sum + (window.interval.end - window.interval.start), 0);
}
