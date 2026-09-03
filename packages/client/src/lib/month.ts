import { daysFromCivil, type CivilDate } from '@ambitime/scheduler';
import type { WeekTypeOverrideEntry } from '@ambitime/shared';
import { addDays, formatCivilDate, parseCivilDate, weekDays, weekdayNames } from './time';

/**
 * The month, as the grid that draws it needs (spec §4.3, §6.1).
 *
 * A month view asks a different question from the week view rather than a
 * zoomed-out version of the same one. The week answers "when today", hour by
 * hour; the month answers "what shape are the next few weeks" — which stretches
 * are away, where the work has piled up, how far the horizon actually reaches.
 * Neither is the other scaled, so this builds its own days rather than drawing
 * `WeekGrid` five times.
 *
 * Everything here is pure and takes its month as an argument, for the reason
 * the engine takes its `now` (§6.3): a grid that read a clock could not be
 * tested and would change under a user at midnight.
 */

export interface MonthDay {
  date: CivilDate;
  /** False for the leading and trailing days that fill the first and last row. */
  inMonth: boolean;
  key: string;
}

/**
 * Whole weeks covering `month`, aligned to the viewer's first day of week.
 *
 * Whole weeks, in the same alignment the week view uses, so a Saturday sits
 * under the same heading on both screens. The days either side of the month are
 * kept and marked rather than blanked: a task on the 1st of next month is worth
 * seeing while you are looking at the end of this one.
 */
export function monthWeeks(month: CivilDate, firstDayOfWeek: number): MonthDay[][] {
  const first: CivilDate = { year: month.year, month: month.month, day: 1 };
  const lastDay = daysFromCivil(addDays(shiftMonth(first, 1), -1));

  const weeks: MonthDay[][] = [];
  let cursor = weekDays(first, firstDayOfWeek)[0] ?? first;

  // A row for every week that starts on or before the month's last day. That
  // is 4 rows for a February that happens to align and 6 for a 31-day month
  // starting on the last column, with no empty row in either case.
  while (daysFromCivil(cursor) <= lastDay) {
    const start = cursor;
    weeks.push(
      Array.from({ length: 7 }, (_, offset) => {
        const date = addDays(start, offset);
        return {
          date,
          inMonth: date.month === month.month && date.year === month.year,
          key: formatCivilDate(date),
        };
      }),
    );
    cursor = addDays(cursor, 7);
  }

  return weeks;
}

/** The month `date` falls in, as the first of it. */
export function monthOf(date: CivilDate): CivilDate {
  return { year: date.year, month: date.month, day: 1 };
}

/** `months` months on, wrapping the year. Negative goes back. */
export function shiftMonth(month: CivilDate, months: number): CivilDate {
  const zeroBased = month.year * 12 + (month.month - 1) + months;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1, day: 1 };
}

/**
 * The special week a date falls in, if any (spec §4.3).
 *
 * **The end date is exclusive**, which is why this is a function rather than a
 * comparison written at each call site. Every interval in the system is
 * half-open (§5.1) and these are stored the same way, so "until the 20th" makes
 * the 19th the last day away — and a grid that shaded the 20th would be
 * disagreeing with the scheduler about which days are which.
 */
export function specialWeekOn(
  date: CivilDate,
  overrides: readonly WeekTypeOverrideEntry[],
): WeekTypeOverrideEntry | null {
  const day = daysFromCivil(date);

  return (
    overrides.find((override) => {
      const start = daysFromCivil(parseCivilDate(override.startDate));
      const end = daysFromCivil(parseCivilDate(override.endDate));
      return day >= start && day < end;
    }) ?? null
  );
}

/** The month's name and year, in the viewer's language. */
export function formatMonth(month: CivilDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(month.year, month.month - 1, 1)));
}

/** Column headings: the seven weekday names, rotated to the viewer's start. */
export function weekdayHeadings(locale: string, firstDayOfWeek: number): string[] {
  const names = weekdayNames(locale, 'short');
  return Array.from({ length: 7 }, (_, offset) => names[(firstDayOfWeek - 1 + offset) % 7] ?? '');
}
