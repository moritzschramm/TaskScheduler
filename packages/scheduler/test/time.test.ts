import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  civilFromDays,
  contains,
  daysFromCivil,
  instantToZonedCivil,
  isoWeekdayFromDays,
  overlaps,
  wallClockToInstant,
  zoneOffsetMinutes,
} from '../src/index.js';
import { at } from './support/fixtures.js';

describe('civil date arithmetic', () => {
  it('anchors the epoch', () => {
    expect(daysFromCivil({ year: 1970, month: 1, day: 1 })).toBe(0);
    expect(civilFromDays(0)).toEqual({ year: 1970, month: 1, day: 1 });
  });

  it('round-trips every date over four centuries', () => {
    // Integer arithmetic with no floating point anywhere (spec §6.3), so this
    // should be exact rather than approximately right.
    fc.assert(
      fc.property(fc.integer({ min: -80_000, max: 80_000 }), (days) => {
        expect(daysFromCivil(civilFromDays(days))).toBe(days);
      }),
      { numRuns: 2000 },
    );
  });

  it('handles leap years including the century rules', () => {
    const feb29 = { year: 2024, month: 2, day: 29 };
    expect(civilFromDays(daysFromCivil(feb29))).toEqual(feb29);

    // 2000 is a leap year, 1900 is not.
    expect(
      daysFromCivil({ year: 2000, month: 3, day: 1 }) -
        daysFromCivil({ year: 2000, month: 2, day: 28 }),
    ).toBe(2);
    expect(
      daysFromCivil({ year: 1900, month: 3, day: 1 }) -
        daysFromCivil({ year: 1900, month: 2, day: 28 }),
    ).toBe(1);
  });

  it('reports ISO weekdays with Monday as 1', () => {
    // 1970-01-01 was a Thursday.
    expect(isoWeekdayFromDays(0)).toBe(4);
    expect(isoWeekdayFromDays(daysFromCivil({ year: 2026, month: 3, day: 23 }))).toBe(1);
    expect(isoWeekdayFromDays(daysFromCivil({ year: 2026, month: 3, day: 29 }))).toBe(7);
  });
});

describe('timezone handling', () => {
  it('reads the offset at the instant, not as a property of the zone', () => {
    // The whole reason DST works: Berlin is UTC+1 in March and UTC+2 in April.
    expect(zoneOffsetMinutes(at('2026-03-23T12:00:00Z'), 'Europe/Berlin')).toBe(60);
    expect(zoneOffsetMinutes(at('2026-03-30T12:00:00Z'), 'Europe/Berlin')).toBe(120);
    expect(zoneOffsetMinutes(at('2026-03-23T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('resolves a wall-clock rule to a different instant either side of DST', () => {
    // Spec §5.1: "every weekday 09:00" is a wall-clock rule; DST shifts the
    // underlying instant, so the zone travels with the rule.
    const beforeSwitch = wallClockToInstant(
      { year: 2026, month: 3, day: 23 },
      9 * 60,
      'Europe/Berlin',
    );
    const afterSwitch = wallClockToInstant(
      { year: 2026, month: 3, day: 30 },
      9 * 60,
      'Europe/Berlin',
    );

    expect(beforeSwitch).toBe(at('2026-03-23T08:00:00Z'));
    expect(afterSwitch).toBe(at('2026-03-30T07:00:00Z'));
  });

  it('resolves back to standard time after the autumn transition', () => {
    const afterAutumn = wallClockToInstant(
      { year: 2026, month: 10, day: 26 },
      9 * 60,
      'Europe/Berlin',
    );
    expect(afterAutumn).toBe(at('2026-10-26T08:00:00Z'));
  });

  it('resolves a skipped local time deterministically', () => {
    // 2026-03-29 02:30 Berlin does not exist; clocks jump 02:00 → 03:00. It must
    // still resolve, and resolve the same way every time (spec §6.3).
    const first = wallClockToInstant({ year: 2026, month: 3, day: 29 }, 150, 'Europe/Berlin');
    const second = wallClockToInstant({ year: 2026, month: 3, day: 29 }, 150, 'Europe/Berlin');

    expect(first).toBe(second);
    expect(Number.isInteger(first)).toBe(true);
  });

  it('resolves an ambiguous local time deterministically', () => {
    // 2026-10-25 02:30 Berlin happens twice.
    const first = wallClockToInstant({ year: 2026, month: 10, day: 25 }, 150, 'Europe/Berlin');
    const second = wallClockToInstant({ year: 2026, month: 10, day: 25 }, 150, 'Europe/Berlin');

    expect(first).toBe(second);
  });

  it('round-trips wall clock through instant for ordinary times', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 28 }), fc.integer({ min: 4, max: 23 }), (day, hour) => {
        // April: comfortably inside CEST, so no transition to trip over.
        const date = { year: 2026, month: 4, day };
        const instant = wallClockToInstant(date, hour * 60, 'Europe/Berlin');
        expect(instantToZonedCivil(instant, 'Europe/Berlin')).toEqual(date);
      }),
      { numRuns: 200 },
    );
  });
});

describe('half-open intervals', () => {
  it('does not treat touching intervals as overlapping', () => {
    // Spec §5.1: 09:00–10:00 and 10:00–11:00 do not conflict. Every overlap
    // check in the validator rests on this.
    const first = { start: 540, end: 600 };
    const second = { start: 600, end: 660 };

    expect(overlaps(first, second)).toBe(false);
    expect(overlaps(second, first)).toBe(false);
  });

  it('detects a genuine overlap in both directions', () => {
    const first = { start: 540, end: 600 };
    const second = { start: 570, end: 630 };

    expect(overlaps(first, second)).toBe(true);
    expect(overlaps(second, first)).toBe(true);
  });

  it('is symmetric for arbitrary intervals', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 200 }),
        (aStart, aLen, bStart, bLen) => {
          const a = { start: aStart, end: aStart + aLen };
          const b = { start: bStart, end: bStart + bLen };
          expect(overlaps(a, b)).toBe(overlaps(b, a));
        },
      ),
    );
  });

  it('treats containment as inclusive of shared edges', () => {
    const outer = { start: 540, end: 660 };

    expect(contains(outer, { start: 540, end: 660 })).toBe(true);
    expect(contains(outer, { start: 560, end: 600 })).toBe(true);
    expect(contains(outer, { start: 530, end: 600 })).toBe(false);
    expect(contains(outer, { start: 600, end: 700 })).toBe(false);
  });
});
