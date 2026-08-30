import { describe, expect, it } from 'vitest';
import { expandTemplate, type RecurringTemplate } from '../../src/schedule/recurrence.js';
import { toInstant, toIso } from '../../src/schedule/instants.js';

/**
 * Appointment recurrence — datetime expansion (spec §8.1).
 *
 * Berlin throughout, and not for flavour: it is UTC+1 in March and UTC+2 in
 * April, and the switch falls inside the fortnight the rest of the suite
 * schedules against. A recurrence engine tested only in UTC passes everything
 * and still moves a user's weekly standup by an hour on the last Sunday in
 * March.
 *
 * The library is only ever asked for wall-clock datetimes; every instant here
 * came from the scheduler's own zone arithmetic. These tests are what holds
 * that seam.
 */
const BERLIN = 'Europe/Berlin';

function template(overrides: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: 'appt-1',
    calendarId: 'cal-1',
    // Monday 2026-03-23, 09:00 Berlin (CET, UTC+1).
    start: '2026-03-23T08:00:00.000Z',
    end: '2026-03-23T08:30:00.000Z',
    rule: 'FREQ=WEEKLY;BYDAY=MO',
    timeZone: BERLIN,
    exdates: [],
    ...overrides,
  };
}

const horizon = (from: string, to: string) => ({ start: toInstant(from), end: toInstant(to) });

const startsOf = (occurrences: { interval: { start: number } }[]) =>
  occurrences.map((occurrence) => toIso(occurrence.interval.start));

describe('expanding a recurrence rule', () => {
  it('repeats weekly on the named day', () => {
    const occurrences = expandTemplate(
      template(),
      horizon('2026-03-23T00:00:00Z', '2026-04-06T00:00:00Z'),
    );

    expect(startsOf(occurrences)).toEqual(['2026-03-23T08:00:00.000Z', '2026-03-30T07:00:00.000Z']);
  });

  it('keeps the wall clock across a DST boundary, not the instant', () => {
    // The 23rd is CET and the 30th is CEST. Both are 09:00 to the person whose
    // calendar it is; only the UTC instant moves. A library asked for instants
    // rather than wall clocks is exactly where this goes wrong.
    const occurrences = expandTemplate(
      template(),
      horizon('2026-03-23T00:00:00Z', '2026-04-06T00:00:00Z'),
    );

    expect(occurrences[0]!.interval.start).toBe(toInstant('2026-03-23T08:00:00Z'));
    expect(occurrences[1]!.interval.start).toBe(toInstant('2026-03-30T07:00:00Z'));

    // And both are still half an hour long: a duration is a duration.
    expect(
      occurrences.map((occurrence) => occurrence.interval.end - occurrence.interval.start),
    ).toEqual([30, 30]);
  });

  it('honours EXDATE', () => {
    const occurrences = expandTemplate(
      template({ exdates: ['2026-03-30T07:00:00.000Z'] }),
      horizon('2026-03-23T00:00:00Z', '2026-04-06T00:00:00Z'),
    );

    // The suppressed instance is named by its *instant*, which after DST is
    // 07:00Z rather than 08:00Z — the same trap, from the other side.
    expect(startsOf(occurrences)).toEqual(['2026-03-23T08:00:00.000Z']);
  });

  it('clips to the horizon at both ends', () => {
    const occurrences = expandTemplate(
      template(),
      horizon('2026-03-24T00:00:00Z', '2026-03-31T00:00:00Z'),
    );

    expect(startsOf(occurrences)).toEqual(['2026-03-30T07:00:00.000Z']);
  });

  it('includes an instance that starts before the horizon but runs into it', () => {
    const occurrences = expandTemplate(
      template({ end: '2026-03-23T10:00:00.000Z' }),
      horizon('2026-03-23T09:00:00Z', '2026-03-24T00:00:00Z'),
    );

    // It occupies time inside the horizon, so the solver has to know about it
    // (§6.2 rule 2). Dropping it would let a task be placed straight through a
    // meeting that was already under way.
    expect(startsOf(occurrences)).toEqual(['2026-03-23T08:00:00.000Z']);
  });

  it('handles daily, interval and count', () => {
    const occurrences = expandTemplate(
      template({ rule: 'FREQ=DAILY;INTERVAL=2;COUNT=3' }),
      horizon('2026-03-23T00:00:00Z', '2026-04-06T00:00:00Z'),
    );

    expect(startsOf(occurrences)).toEqual([
      '2026-03-23T08:00:00.000Z',
      '2026-03-25T08:00:00.000Z',
      '2026-03-27T08:00:00.000Z',
    ]);
  });

  it('handles monthly by weekday, where the date moves', () => {
    const occurrences = expandTemplate(
      template({ rule: 'FREQ=MONTHLY;BYDAY=1MO' }),
      horizon('2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z'),
    );

    // First Monday of April and May — not March, whose first Monday is the
    // 2nd and so falls before the series begins on the 23rd. A rule never
    // produces an instance earlier than its own start, and the row's `during`
    // is what supplies that start rather than anything in the rule text.
    // Both are CEST, hence 07:00Z for a 09:00 local meeting.
    expect(startsOf(occurrences)).toEqual(['2026-04-06T07:00:00.000Z', '2026-05-04T07:00:00.000Z']);
  });

  it('expands a UTC calendar without a zone conversion changing anything', () => {
    const occurrences = expandTemplate(
      template({ timeZone: 'UTC' }),
      horizon('2026-03-23T00:00:00Z', '2026-04-06T00:00:00Z'),
    );

    // No DST in UTC, so both instances keep the same instant-of-day.
    expect(startsOf(occurrences)).toEqual(['2026-03-23T08:00:00.000Z', '2026-03-30T08:00:00.000Z']);
  });

  it('reports which instance each occurrence is', () => {
    const occurrences = expandTemplate(
      template(),
      horizon('2026-03-23T00:00:00Z', '2026-04-06T00:00:00Z'),
    );

    // The unmodified start is the identity of an instance: it is what an
    // EXDATE names and what a modified occurrence points at.
    expect(occurrences.map((occurrence) => occurrence.originalStart)).toEqual(
      occurrences.map((occurrence) => occurrence.interval.start),
    );
  });
});
