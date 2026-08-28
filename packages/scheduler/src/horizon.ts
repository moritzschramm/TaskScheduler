import {
  civilFromDays,
  daysFromCivil,
  instantToZonedCivil,
  isoWeekdayFromDays,
  wallClockToInstant,
  type CivilDate,
  type Instant,
  type Interval,
} from './time.js';
import type { TuningConfig } from './config.js';

/**
 * The horizon model (spec §6.1).
 *
 * The hard horizon is the current week plus the next one: tasks inside it are
 * placed to specific datetimes, everything beyond sits in the backlog with an
 * estimated week. Bounding it is what keeps solver cost predictable, and it
 * matches reality — much changes within two weeks, and later tasks get
 * re-planned regardless.
 *
 * Week boundaries are local, and honour the user's first-day-of-week setting
 * (§13), which is why `estimated_week` is stored as a week-start date rather
 * than an ISO week number.
 */

/** The local date on which the week containing `instant` begins. */
export function weekStartDate(
  instant: Instant,
  timeZone: string,
  firstDayOfWeek: number,
): CivilDate {
  const localDate = instantToZonedCivil(instant, timeZone);
  const days = daysFromCivil(localDate);
  const weekday = isoWeekdayFromDays(days);

  // Days to step back to reach the configured first day, never negative.
  const back = (((weekday - firstDayOfWeek) % 7) + 7) % 7;
  return civilFromDays(days - back);
}

/** Local midnight on a date, as an instant. */
export function startOfLocalDay(date: CivilDate, timeZone: string): Instant {
  return wallClockToInstant(date, 0, timeZone);
}

/** The date `weeks` weeks after `date`. */
export function addWeeks(date: CivilDate, weeks: number): CivilDate {
  return civilFromDays(daysFromCivil(date) + weeks * 7);
}

/**
 * The hard horizon: `[start of this week, start of the week after next)`.
 *
 * `now` is an explicit input — the engine never reads a clock (spec §6.3).
 */
export function computeHardHorizon(now: Instant, timeZone: string, config: TuningConfig): Interval {
  const firstWeek = weekStartDate(now, timeZone, config.firstDayOfWeek);
  return {
    start: startOfLocalDay(firstWeek, timeZone),
    end: startOfLocalDay(addWeeks(firstWeek, config.hardHorizonWeeks), timeZone),
  };
}

export interface PlanningWeek {
  /** Local date the week begins on — what `estimated_week` stores. */
  startDate: CivilDate;
  interval: Interval;
}

/**
 * The weeks the coarse planner may assign to: those beyond the hard horizon,
 * out to `backlogPlanningWeeks`.
 */
export function planningWeeksAfter(
  horizon: Interval,
  timeZone: string,
  config: TuningConfig,
): PlanningWeek[] {
  const firstWeek = weekStartDate(horizon.end, timeZone, config.firstDayOfWeek);
  const weeks: PlanningWeek[] = [];

  for (let index = 0; index < config.backlogPlanningWeeks; index += 1) {
    const startDate = addWeeks(firstWeek, index);
    weeks.push({
      startDate,
      interval: {
        start: startOfLocalDay(startDate, timeZone),
        end: startOfLocalDay(addWeeks(startDate, 1), timeZone),
      },
    });
  }

  return weeks;
}

/** Formats a week-start date as `YYYY-MM-DD`, the form the database stores. */
export function formatCivilDate({ year, month, day }: CivilDate): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}
