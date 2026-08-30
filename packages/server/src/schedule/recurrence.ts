import { rrulestr } from 'rrule';
import {
  instantToZonedCivil,
  wallClockToInstant,
  type Instant,
  type Interval,
} from '@ambitime/scheduler';
import { toInstant } from './instants.js';

/**
 * Appointment recurrence — datetime expansion (spec §8.1).
 *
 * The other engine, §8.2's per-period task demand, shares nothing with this and
 * must not: that one says how much a period should hold and lets the scheduler
 * choose when, while this one says exactly when and lets nothing choose. They
 * look alike in a UI and are opposites underneath.
 *
 * **Why the library only parses, and never computes an instant.**
 *
 * The scheduler has its own time model — integer minutes since the epoch, and
 * its own zone-offset arithmetic — and every RRULE library has a different one
 * built on `Date`. Mixing the two would put two answers to "what instant is
 * 09:00 on the last Sunday in March" inside one system, and that Sunday is
 * precisely the day they would differ.
 *
 * So `rrule` is asked for **wall-clock** datetimes: the rule is expanded in
 * floating (UTC-labelled) mode, and each result is read as "09:00 on this local
 * date" and converted by `wallClockToInstant` in the rule's own stored zone.
 * DST correctness therefore comes from the same code that already gets
 * availability windows right (§5.1), and the library never sees a timezone at
 * all.
 */

export interface RecurringTemplate {
  id: string;
  calendarId: string;
  /** The first instance; its wall-clock time is the rule's time-of-day. */
  start: string;
  end: string;
  rule: string;
  timeZone: string;
  /** Instances suppressed from the expansion (RFC 5545 EXDATE). */
  exdates: string[];
}

export interface ExpandedOccurrence {
  /** The template this came from; several occurrences share one id. */
  appointmentId: string;
  calendarId: string;
  interval: Interval;
  /** Which instance of the template this is — its unmodified start. */
  originalStart: Instant;
}

/**
 * Every instance of a template overlapping the horizon, in start order.
 *
 * Occurrences that a modified instance replaces are *not* removed here: the
 * caller knows which those are, because it loaded them, and passing that
 * knowledge down would make this function need a second input to answer a
 * question about its first.
 */
export function expandTemplate(
  template: RecurringTemplate,
  horizon: Interval,
): ExpandedOccurrence[] {
  const durationMin = toInstant(template.end) - toInstant(template.start);
  const suppressed = new Set(template.exdates.map((exdate) => toInstant(exdate)));

  // The window asked of the library is widened by a day either side, in
  // wall-clock terms: a local day straddles UTC midnight by up to a whole
  // offset, so an instance just outside the horizon in UTC can still start
  // inside it locally.
  const from = toWallClockDate(horizon.start - MINUTES_PER_DAY, template.timeZone);
  const until = toWallClockDate(horizon.end + MINUTES_PER_DAY, template.timeZone);

  const occurrences: ExpandedOccurrence[] = [];

  for (const wallClock of expandRule(template, from, until)) {
    const start = wallClockToInstant(
      {
        year: wallClock.getUTCFullYear(),
        month: wallClock.getUTCMonth() + 1,
        day: wallClock.getUTCDate(),
      },
      wallClock.getUTCHours() * 60 + wallClock.getUTCMinutes(),
      template.timeZone,
    );

    if (suppressed.has(start)) continue;

    const interval = { start, end: start + durationMin };
    if (interval.end <= horizon.start || interval.start >= horizon.end) continue;

    occurrences.push({
      appointmentId: template.id,
      calendarId: template.calendarId,
      interval,
      originalStart: start,
    });
  }

  return occurrences.sort((a, b) => a.interval.start - b.interval.start);
}

/**
 * The rule's wall-clock datetimes, as UTC-labelled `Date`s.
 *
 * `DTSTART` is supplied from the template's own start read in its zone, so a
 * rule stored without one still expands from the right time of day — and one
 * stored *with* one is overridden, because the row is the authority on when the
 * series begins.
 */
function expandRule(template: RecurringTemplate, from: Date, until: Date): Date[] {
  const civil = instantToZonedCivil(toInstant(template.start), template.timeZone);
  const minuteOfDay = localMinuteOfDay(toInstant(template.start), template.timeZone);

  const dtstart = new Date(
    Date.UTC(
      civil.year,
      civil.month - 1,
      civil.day,
      Math.floor(minuteOfDay / 60),
      minuteOfDay % 60,
    ),
  );

  const rule = rrulestr(template.rule, { dtstart, forceset: false });

  // Inclusive of both bounds: an instance starting exactly at the horizon edge
  // is inside it, and the caller clips.
  return rule.between(from, until, true);
}

const MINUTES_PER_DAY = 1440;

/** An instant as the UTC-labelled `Date` that spells its local wall clock. */
function toWallClockDate(instant: Instant, timeZone: string): Date {
  const civil = instantToZonedCivil(instant, timeZone);
  const minuteOfDay = localMinuteOfDay(instant, timeZone);

  return new Date(
    Date.UTC(
      civil.year,
      civil.month - 1,
      civil.day,
      Math.floor(minuteOfDay / 60),
      minuteOfDay % 60,
    ),
  );
}

function localMinuteOfDay(instant: Instant, timeZone: string): number {
  const dayStart = wallClockToInstant(instantToZonedCivil(instant, timeZone), 0, timeZone);
  return instant - dayStart;
}
