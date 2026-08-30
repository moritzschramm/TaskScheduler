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
import type {
  AvailabilityRule,
  CalendarSpec,
  ResolvedWindow,
  WeekdayRange,
  WeekTypeOverride,
} from './types.js';

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
    // Merged once per calendar rather than once per local day: the working
    // window is a weekly rule, so 15 days of horizon would otherwise redo the
    // same coalescing fifteen times.
    const working = mergeWorkingWindow(calendar.workingWindow);

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

        // One rule can yield several spans: a working window split across a
        // lunch break cuts a single 09:00–17:00 availability in two. They share
        // a rule id, which the validator already expects — a resolved window is
        // identified by its rule *and* its span, not by the rule alone.
        for (const span of workingSpans(rule, working[weekday])) {
          const start = wallClockToInstant(date, span.startMin, calendar.timeZone);
          const end = wallClockToInstant(date, span.endMin, calendar.timeZone);
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
  }

  return sorted(resolved, compareResolvedWindows);
}

/** A half-open range of minutes within one local day. */
interface MinuteSpan {
  startMin: number;
  endMin: number;
}

/**
 * The working window (spec §9.1) as a per-weekday lookup, with overlapping and
 * touching ranges coalesced.
 *
 * Coalescing is not tidiness. Two overlapping ranges would clip one
 * availability rule into two overlapping spans, and the solver would then see
 * the same candidate slot twice — identical score, identical start, identical
 * rule id, and therefore no total order to break the tie with (spec §6.3).
 *
 * `undefined` in, `undefined` out: a calendar with no working window is
 * unrestricted, and every weekday must go on saying so.
 */
function mergeWorkingWindow(
  window: readonly WeekdayRange[] | undefined,
): Record<number, MinuteSpan[] | undefined> {
  if (window === undefined) return {};

  const byWeekday: Record<number, MinuteSpan[] | undefined> = {};
  // Every weekday gets an entry, so a weekday the window says nothing about
  // reads as "no working time" rather than as "unrestricted".
  for (let weekday = 1; weekday <= 7; weekday += 1) byWeekday[weekday] = [];

  for (const range of window) {
    byWeekday[range.weekday]?.push({ startMin: range.startMin, endMin: range.endMin });
  }

  for (const weekday of Object.keys(byWeekday)) {
    const spans = sorted(
      byWeekday[Number(weekday)] ?? [],
      byInt((span) => span.startMin),
    );
    const merged: MinuteSpan[] = [];

    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last !== undefined && span.startMin <= last.endMin) {
        last.endMin = Math.max(last.endMin, span.endMin);
        continue;
      }
      merged.push({ ...span });
    }

    byWeekday[Number(weekday)] = merged;
  }

  return byWeekday;
}

/** A rule's minutes, clipped to the working window in force on that weekday. */
function workingSpans(rule: AvailabilityRule, working: MinuteSpan[] | undefined): MinuteSpan[] {
  if (working === undefined) return [{ startMin: rule.startMin, endMin: rule.endMin }];

  const spans: MinuteSpan[] = [];
  for (const span of working) {
    const startMin = Math.max(rule.startMin, span.startMin);
    const endMin = Math.min(rule.endMin, span.endMin);
    if (startMin < endMin) spans.push({ startMin, endMin });
  }
  return spans;
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
