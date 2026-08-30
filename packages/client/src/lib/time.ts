import {
  civilFromDays,
  daysFromCivil,
  instantToZonedCivil,
  isoWeekdayFromDays,
  MINUTES_PER_DAY,
  zoneOffsetMinutes,
  type CivilDate,
  type Instant,
} from '@ambitime/scheduler';

/**
 * Wall-clock time, in the calendar's zone (spec §13, §5.1).
 *
 * Storage is UTC and display is local — which for a calendar means a specific
 * zone, not the browser's. A user in Lisbon looking at a Berlin calendar must
 * see the Berlin working day, or the grid is drawing something that never
 * happened.
 *
 * Every conversion below delegates to the **scheduler package**, which already
 * has to answer these questions to place anything at all. Reimplementing zone
 * arithmetic here would give the client a second opinion about what 09:00 means
 * — and the whole point of the isomorphic engine (§3.3) is that there is one.
 * What this module adds is only the ISO⇄minutes boundary, which the scheduler
 * deliberately refuses to have.
 */

const MS_PER_MINUTE = 60_000;

/** ISO-8601 → the engine's integer minutes since the epoch. */
export function toInstant(iso: string): Instant {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) throw new Error(`Not an ISO-8601 instant: ${iso}`);
  return Math.floor(millis / MS_PER_MINUTE);
}

export function toIso(instant: Instant): string {
  return new Date(instant * MS_PER_MINUTE).toISOString();
}

/** The local calendar date an instant falls on, in `timeZone`. */
export function localDate(iso: string, timeZone: string): CivilDate {
  return instantToZonedCivil(toInstant(iso), timeZone);
}

/**
 * Minutes since local midnight.
 *
 * This is the number the grid positions with: a block at 09:00 Berlin sits 540
 * minutes down the column whatever the offset happens to be that week, which is
 * what makes a DST weekend render as a normal working day rather than as an
 * hour of drift.
 */
export function minuteOfDay(iso: string, timeZone: string): number {
  const instant = toInstant(iso);
  const local = instant + zoneOffsetMinutes(instant, timeZone);
  return ((local % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function formatCivilDate(date: CivilDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

export function parseCivilDate(value: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Not a calendar date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The seven local dates of the week `date` falls in.
 *
 * `firstDayOfWeek` is the user's setting (§13), ISO-numbered — 1 is Monday.
 */
export function weekDays(date: CivilDate, firstDayOfWeek: number): CivilDate[] {
  const days = daysFromCivil(date);
  const weekday = isoWeekdayFromDays(days);
  const offset = (weekday - firstDayOfWeek + 7) % 7;
  const start = days - offset;

  return Array.from({ length: 7 }, (_, index) => civilFromDays(start + index));
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return civilFromDays(daysFromCivil(date) + days);
}

export function sameCivilDate(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** `540` → `09:00`. The grid's axis labels and block times. */
export function formatMinuteOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * `09:00` → `540`, the inverse of `formatMinuteOfDay`.
 *
 * `<input type="time">` always yields 24-hour `HH:MM` whatever the browser
 * displays, so this parses one format regardless of locale. Anything else —
 * an emptied field, a partial entry — returns `null` rather than a number the
 * caller would have to guess at.
 */
export function parseMinuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1440 ? minutes : null;
}

/** ISO-8601 weekday names, 1 = Monday … 7 = Sunday, in the user's locale. */
export function weekdayNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  // 2026-03-23 is a Monday, so this walks Monday to Sunday in ISO order.
  return Array.from({ length: 7 }, (_, offset) =>
    format.format(new Date(Date.UTC(2026, 2, 23 + offset))),
  );
}

/** `2026-03-23` → `Mon 23 Mar`, in the user's locale. */
export function formatDayLabel(date: CivilDate, locale: string): string {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(utc);
}
