/**
 * Time primitives for the scheduler.
 *
 * Everything here is **integer minutes**. Spec §6.3 requires that ordering use
 * integer-minute arithmetic and that floating-point values never participate in
 * a comparison that decides placement — the simplest way to guarantee that is
 * to have no other representation in the engine at all.
 *
 * There is deliberately no use of `Date`: not for the current time (the solver
 * takes `now` as an explicit input) and not for calendar arithmetic either,
 * which is done below with exact integer algorithms. `Intl` appears only to ask
 * a timezone for its UTC offset at a given instant, which is a pure lookup.
 */

/** Integer minutes since the Unix epoch, UTC. The engine's only instant type. */
export type Instant = number;

/** Integer minutes since local midnight, in `[0, 1440]`. */
export type MinuteOfDay = number;

/** A proleptic Gregorian calendar date, with no time and no zone attached. */
export interface CivilDate {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

/**
 * A half-open interval `[start, end)` (spec §5.1). A 09:00–10:00 block and a
 * 10:00–11:00 block do not conflict, which is the property every overlap test
 * in the validator depends on.
 */
export interface Interval {
  start: Instant;
  end: Instant;
}

export const MINUTES_PER_DAY = 1440;
const MINUTES_PER_MILLISECOND = 60_000;

/** Days from 1970-01-01 for a civil date (Howard Hinnant's `days_from_civil`). */
export function daysFromCivil({ year, month, day }: CivilDate): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400; // [0, 399]
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097; // [0, 146096]
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153); // [0, 11], March-based
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

/**
 * ISO-8601 weekday: 1 = Monday … 7 = Sunday, matching the `weekday` column and
 * Postgres's `extract(isodow)`.
 */
export function isoWeekdayFromDays(days: number): number {
  // 1970-01-01 was a Thursday (ISO weekday 4).
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

/** Treats a civil date and minute-of-day as if the local zone were UTC. */
export function utcCivilToInstant(date: CivilDate, minuteOfDay: MinuteOfDay): Instant {
  return daysFromCivil(date) * MINUTES_PER_DAY + minuteOfDay;
}

export function instantToUtcDays(instant: Instant): number {
  return Math.floor(instant / MINUTES_PER_DAY);
}

export function instantToUtcCivil(instant: Instant): CivilDate {
  return civilFromDays(instantToUtcDays(instant));
}

// Constructing an Intl.DateTimeFormat is expensive relative to using one, and
// window resolution asks for offsets once per day of the horizon. The cache is
// keyed by zone and holds no mutable state beyond memoised formatters, so it
// does not make the module's behaviour depend on call order.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The zone's UTC offset, in minutes, *at a given instant*.
 *
 * Derived by asking Intl what wall-clock time the zone shows at that instant
 * and measuring the difference. This is what makes DST handling correct without
 * a timezone database of our own: the offset is a function of the instant, not
 * a fixed property of the zone.
 */
export function zoneOffsetMinutes(instant: Instant, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(instant * MINUTES_PER_MILLISECOND);

  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      default:
        break;
    }
  }

  const localAsIfUtc = utcCivilToInstant({ year, month, day }, hour * 60 + minute);
  return localAsIfUtc - instant;
}

/**
 * Converts a local wall-clock time in a zone to the instant it denotes.
 *
 * Spec §5.1: "every weekday 09:00" is a wall-clock rule, and DST shifts the
 * underlying instant, so the zone has to travel with the rule. The two-pass
 * correction is what handles the shift: the offset is looked up at a first
 * guess, then re-checked at the resulting instant, because a naive guess landing
 * near a transition can read the wrong side of it.
 *
 * Local times that do not exist (the hour skipped by a spring-forward) resolve
 * into the gap, and ambiguous ones (repeated by a fall-back) resolve to the
 * first occurrence. Both are deterministic, which is what the engine requires.
 */
export function wallClockToInstant(
  date: CivilDate,
  minuteOfDay: MinuteOfDay,
  timeZone: string,
): Instant {
  const naive = utcCivilToInstant(date, minuteOfDay);

  const firstGuessOffset = zoneOffsetMinutes(naive, timeZone);
  const candidate = naive - firstGuessOffset;

  const settledOffset = zoneOffsetMinutes(candidate, timeZone);
  return settledOffset === firstGuessOffset ? candidate : naive - settledOffset;
}

/** The local civil date a zone is showing at an instant. */
export function instantToZonedCivil(instant: Instant, timeZone: string): CivilDate {
  return civilFromDays(instantToUtcDays(instant + zoneOffsetMinutes(instant, timeZone)));
}

/** Half-open overlap: `[a.start, a.end)` and `[b.start, b.end)` share a minute. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Whether `inner` lies entirely within `outer`, both half-open. */
export function contains(outer: Interval, inner: Interval): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/** The overlapping part of two intervals, or `null` when they are disjoint. */
export function intersection(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

export function durationOf(interval: Interval): number {
  return interval.end - interval.start;
}

export function isEmpty(interval: Interval): boolean {
  return interval.end <= interval.start;
}

/**
 * A `YYYY-MM-DD` string as a civil date.
 *
 * Lives beside the rest of the calendar arithmetic rather than in a server
 * module, because both sides of the wire parse these: a command carries dates
 * as text, and the client has to read the same ones the server does.
 */
export function toCivilDate(value: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Not a YYYY-MM-DD date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}
