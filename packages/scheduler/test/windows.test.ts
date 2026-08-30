import { describe, expect, it } from 'vitest';
import { resolveWindows, totalWindowMinutes, type AvailabilityRule } from '../src/index.js';
import { at } from './support/fixtures.js';

const berlin = [{ id: 'cal-1', timeZone: 'Europe/Berlin' }];
const utc = [{ id: 'cal-1', timeZone: 'UTC' }];

/** Monday 09:00–12:00 local. */
const mondayRule: AvailabilityRule = {
  id: 'r-mon',
  calendarId: 'cal-1',
  categoryId: 'cat-work',
  weekday: 1,
  startMin: 9 * 60,
  endMin: 12 * 60,
};

describe('availability window resolution', () => {
  it('expands a weekly rule to one instance per matching weekday', () => {
    const windows = resolveWindows({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-04-06T00:00:00Z') },
      calendars: utc,
      rules: [mondayRule],
    });

    // Two full weeks contain two Mondays: the 23rd and the 30th.
    expect(windows).toHaveLength(2);
    expect(windows[0]?.interval.start).toBe(at('2026-03-23T09:00:00Z'));
    expect(windows[1]?.interval.start).toBe(at('2026-03-30T09:00:00Z'));
  });

  it('resolves the same wall-clock rule to different instants across DST', () => {
    // Spec §5.1. The 23rd is CET (UTC+1), the 30th is CEST (UTC+2), and a rule
    // that ignored this would silently shift the user's whole morning.
    const windows = resolveWindows({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-04-06T00:00:00Z') },
      calendars: berlin,
      rules: [mondayRule],
    });

    expect(windows[0]?.interval.start).toBe(at('2026-03-23T08:00:00Z'));
    expect(windows[1]?.interval.start).toBe(at('2026-03-30T07:00:00Z'));
    // Both are three local hours long, which is the point of a wall-clock rule.
    expect(windows.map((w) => w.interval.end - w.interval.start)).toEqual([180, 180]);
  });

  it('clips windows to the horizon', () => {
    const windows = resolveWindows({
      horizon: { start: at('2026-03-23T10:00:00Z'), end: at('2026-03-23T11:00:00Z') },
      calendars: utc,
      rules: [mondayRule],
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.interval).toEqual({
      start: at('2026-03-23T10:00:00Z'),
      end: at('2026-03-23T11:00:00Z'),
    });
  });

  it('includes a local day whose window reaches into the horizon from outside it', () => {
    // A local day straddles UTC midnight, so a window can begin on the calendar
    // day before the horizon starts and still overlap it.
    const lateRule: AvailabilityRule = { ...mondayRule, startMin: 22 * 60, endMin: 23 * 60 + 59 };

    const windows = resolveWindows({
      // Horizon opens just after the local window has already begun.
      horizon: { start: at('2026-03-23T21:30:00Z'), end: at('2026-03-24T06:00:00Z') },
      calendars: berlin,
      rules: [lateRule],
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.interval.start).toBe(at('2026-03-23T21:30:00Z'));
  });

  it('drops rules for other calendars and keeps the category on the result', () => {
    const windows = resolveWindows({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-24T00:00:00Z') },
      calendars: utc,
      rules: [mondayRule, { ...mondayRule, id: 'r-other', calendarId: 'cal-2' }],
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.ruleId).toBe('r-mon');
    expect(windows[0]?.categoryId).toBe('cat-work');
  });

  it('carries the focus level through for the scoring term in M4', () => {
    const windows = resolveWindows({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-24T00:00:00Z') },
      calendars: utc,
      rules: [{ ...mondayRule, focusLevel: 4 }],
    });

    expect(windows[0]?.focusLevel).toBe(4);
  });

  describe('the working window (spec §9.1)', () => {
    const horizon = { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-24T00:00:00Z') };

    it('leaves availability alone when no working window is set', () => {
      // Absent is not empty. A calendar nobody has configured a working window
      // for is not a calendar nobody may work in.
      const windows = resolveWindows({ horizon, calendars: utc, rules: [mondayRule] });

      expect(windows).toHaveLength(1);
      expect(windows[0]?.interval).toEqual({
        start: at('2026-03-23T09:00:00Z'),
        end: at('2026-03-23T12:00:00Z'),
      });
    });

    it('clips availability to the working window', () => {
      const windows = resolveWindows({
        horizon,
        calendars: [
          {
            id: 'cal-1',
            timeZone: 'UTC',
            workingWindow: [{ weekday: 1, startMin: 10 * 60, endMin: 11 * 60 }],
          },
        ],
        rules: [mondayRule],
      });

      expect(windows).toHaveLength(1);
      expect(windows[0]?.interval).toEqual({
        start: at('2026-03-23T10:00:00Z'),
        end: at('2026-03-23T11:00:00Z'),
      });
    });

    it('splits one rule across a working window with a gap in it', () => {
      const windows = resolveWindows({
        horizon,
        calendars: [
          {
            id: 'cal-1',
            timeZone: 'UTC',
            workingWindow: [
              { weekday: 1, startMin: 9 * 60, endMin: 10 * 60 },
              { weekday: 1, startMin: 11 * 60, endMin: 13 * 60 },
            ],
          },
        ],
        rules: [mondayRule],
      });

      // Two spans from one rule, both carrying its id — a resolved window is a
      // rule *and* a span, which is what the validator already assumes.
      expect(windows.map((w) => w.ruleId)).toEqual(['r-mon', 'r-mon']);
      expect(windows.map((w) => [w.interval.start, w.interval.end])).toEqual([
        [at('2026-03-23T09:00:00Z'), at('2026-03-23T10:00:00Z')],
        [at('2026-03-23T11:00:00Z'), at('2026-03-23T12:00:00Z')],
      ]);
    });

    it('coalesces overlapping working ranges rather than emitting a slot twice', () => {
      const windows = resolveWindows({
        horizon,
        calendars: [
          {
            id: 'cal-1',
            timeZone: 'UTC',
            workingWindow: [
              { weekday: 1, startMin: 9 * 60, endMin: 11 * 60 },
              { weekday: 1, startMin: 10 * 60, endMin: 12 * 60 },
            ],
          },
        ],
        rules: [mondayRule],
      });

      // Without coalescing these two ranges would produce two overlapping
      // windows, and the solver's tie-break (score, start, rule id) would have
      // no way to order the duplicate candidates they generate (spec §6.3).
      expect(windows).toHaveLength(1);
      expect(windows[0]?.interval).toEqual({
        start: at('2026-03-23T09:00:00Z'),
        end: at('2026-03-23T12:00:00Z'),
      });
    });

    it('places nothing on a weekday the working window omits', () => {
      const windows = resolveWindows({
        horizon,
        calendars: [
          {
            id: 'cal-1',
            timeZone: 'UTC',
            workingWindow: [{ weekday: 2, startMin: 9 * 60, endMin: 17 * 60 }],
          },
        ],
        rules: [mondayRule],
      });

      // A working window that names only Tuesday says Monday is not worked.
      expect(windows).toEqual([]);
    });

    it('places nothing at all for an explicitly empty working window', () => {
      const windows = resolveWindows({
        horizon,
        calendars: [{ id: 'cal-1', timeZone: 'UTC', workingWindow: [] }],
        rules: [mondayRule],
      });

      expect(windows).toEqual([]);
    });

    it("applies the clip in the calendar's zone, not UTC", () => {
      // 09:00–12:00 Berlin is 08:00–11:00 UTC in March. A working window of
      // 10:00–12:00 *local* must keep the last two local hours, not the two
      // hours that happen to share those numbers in UTC.
      const windows = resolveWindows({
        horizon,
        calendars: [
          {
            id: 'cal-1',
            timeZone: 'Europe/Berlin',
            workingWindow: [{ weekday: 1, startMin: 10 * 60, endMin: 12 * 60 }],
          },
        ],
        rules: [mondayRule],
      });

      expect(windows[0]?.interval).toEqual({
        start: at('2026-03-23T09:00:00Z'),
        end: at('2026-03-23T11:00:00Z'),
      });
    });
  });

  describe('week-type overrides', () => {
    const holidayRule: AvailabilityRule = {
      id: 'r-holiday',
      calendarId: 'cal-1',
      categoryId: 'cat-work',
      weekTypeOverrideId: 'ovr-holiday',
      weekday: 1,
      startMin: 14 * 60,
      endMin: 16 * 60,
    };
    const holiday = {
      id: 'ovr-holiday',
      calendarId: 'cal-1',
      startDate: { year: 2026, month: 3, day: 30 },
      endDate: { year: 2026, month: 4, day: 6 },
    };

    it('replaces the default set inside the override range', () => {
      // Spec §4.3: an override *replaces* the default windows, it does not add to them.
      const windows = resolveWindows({
        horizon: { start: at('2026-03-30T00:00:00Z'), end: at('2026-03-31T00:00:00Z') },
        calendars: utc,
        rules: [mondayRule, holidayRule],
        overrides: [holiday],
      });

      expect(windows).toHaveLength(1);
      expect(windows[0]?.ruleId).toBe('r-holiday');
      expect(windows[0]?.interval.start).toBe(at('2026-03-30T14:00:00Z'));
    });

    it('leaves the default set in force outside the range', () => {
      const windows = resolveWindows({
        horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-24T00:00:00Z') },
        calendars: utc,
        rules: [mondayRule, holidayRule],
        overrides: [holiday],
      });

      expect(windows).toHaveLength(1);
      expect(windows[0]?.ruleId).toBe('r-mon');
    });

    it('treats the override range as half-open', () => {
      // Consistent with every other interval in the system (spec §5.1).
      const onEndDate = resolveWindows({
        horizon: { start: at('2026-04-06T00:00:00Z'), end: at('2026-04-07T00:00:00Z') },
        calendars: utc,
        rules: [mondayRule, holidayRule],
        overrides: [holiday],
      });

      // 2026-04-06 is the exclusive end, so the default rule applies again.
      expect(onEndDate[0]?.ruleId).toBe('r-mon');
    });

    it('leaves a day empty when the override supplies no rule for it', () => {
      const windows = resolveWindows({
        horizon: { start: at('2026-03-30T00:00:00Z'), end: at('2026-03-31T00:00:00Z') },
        calendars: utc,
        rules: [mondayRule],
        overrides: [holiday],
      });

      // Vacation weeks legitimately have no availability at all.
      expect(windows).toEqual([]);
    });

    it('picks overlapping overrides by a documented total order', () => {
      // The spec is silent and there is no database constraint preventing
      // overlap, so resolution must not depend on input order (spec §6.3).
      const second = {
        id: 'ovr-aaa',
        calendarId: 'cal-1',
        startDate: { year: 2026, month: 3, day: 30 },
        endDate: { year: 2026, month: 4, day: 6 },
      };
      const secondRule: AvailabilityRule = {
        ...holidayRule,
        id: 'r-aaa',
        weekTypeOverrideId: 'ovr-aaa',
        startMin: 8 * 60,
        endMin: 9 * 60,
      };

      const input = {
        horizon: { start: at('2026-03-30T00:00:00Z'), end: at('2026-03-31T00:00:00Z') },
        calendars: utc,
        rules: [mondayRule, holidayRule, secondRule],
      };

      const forwards = resolveWindows({ ...input, overrides: [holiday, second] });
      const backwards = resolveWindows({ ...input, overrides: [second, holiday] });

      expect(forwards).toEqual(backwards);
      // Same start date, so the id breaks the tie: 'ovr-aaa' sorts first.
      expect(forwards[0]?.ruleId).toBe('r-aaa');
    });
  });

  it('sums available minutes for the capacity work in M5', () => {
    const windows = resolveWindows({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-04-06T00:00:00Z') },
      calendars: utc,
      rules: [mondayRule],
    });

    expect(totalWindowMinutes(windows)).toBe(360);
  });
});
