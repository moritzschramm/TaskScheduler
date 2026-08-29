import {
  addWeeks,
  civilFromDays,
  daysFromCivil,
  instantToZonedCivil,
  startOfLocalDay,
  weekStartDate,
  type CivilDate,
  type Instant,
  type Interval,
  type TuningConfig,
} from '@ambitime/scheduler';
import { toCivilDate } from './instants.js';

/**
 * Local days and weeks (spec §6.1, §13).
 *
 * "The rest of today" and "next week" are wall-clock notions: they depend on
 * the calendar's zone and, for a week, on where the user's week begins. All of
 * the arithmetic is the scheduler's — reimplementing DST-aware day boundaries
 * here would be a second implementation to keep in step with the first.
 */

/** The local day containing an instant, as a half-open interval. */
export function localDayOf(instant: Instant, timeZone: string): Interval {
  return localDay(instantToZonedCivil(instant, timeZone), timeZone);
}

/** A named local date, as a half-open interval. */
export function localDay(date: CivilDate, timeZone: string): Interval {
  return {
    start: startOfLocalDay(date, timeZone),
    end: startOfLocalDay(civilFromDays(daysFromCivil(date) + 1), timeZone),
  };
}

/** The local week containing a date, honouring `firstDayOfWeek` (§13). */
export function localWeek(date: CivilDate, timeZone: string, config: TuningConfig): Interval {
  const start = weekStartDate(startOfLocalDay(date, timeZone), timeZone, config.firstDayOfWeek);
  return {
    start: startOfLocalDay(start, timeZone),
    end: startOfLocalDay(addWeeks(start, 1), timeZone),
  };
}

/** Midnight at the start of the next local day — where "tomorrow" begins. */
export function startOfNextDay(instant: Instant, timeZone: string): Instant {
  return localDayOf(instant, timeZone).end;
}

/** Midnight at the start of the next local week (§7.3's `next_week`). */
export function startOfNextWeek(instant: Instant, timeZone: string, config: TuningConfig): Instant {
  const thisWeek = weekStartDate(instant, timeZone, config.firstDayOfWeek);
  return startOfLocalDay(addWeeks(thisWeek, 1), timeZone);
}

/** A `YYYY-MM-DD` command parameter as a local day. */
export function dayFromParam(value: string, timeZone: string): Interval {
  return localDay(toCivilDate(value), timeZone);
}

/** A `YYYY-MM-DD` command parameter as the local week containing it. */
export function weekFromParam(value: string, timeZone: string, config: TuningConfig): Interval {
  return localWeek(toCivilDate(value), timeZone, config);
}
