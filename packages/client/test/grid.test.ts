import { describe, expect, it } from 'vitest';
import type { FixedBlock, ScheduledBlock } from '@ambitime/shared';
import { blocksForDay, dragOffsetMinutes, movedStartMin, SCALE, snapToGrid } from '@/lib/grid';
import { minuteOfDay, parseCivilDate, weekDays } from '@/lib/time';

/**
 * Grid arithmetic (plan M10's review focus: grid correctness, timezone
 * handling).
 *
 * Berlin throughout, and not for flavour: it is UTC+1 in March and UTC+2 in
 * April, and the switch happens inside the fortnight the rest of the suite
 * schedules against. A grid tested only in UTC would pass every one of these
 * and still draw the last Sunday in March an hour wrong.
 */

const BERLIN = 'Europe/Berlin';

function task(overrides: Partial<ScheduledBlock> = {}): ScheduledBlock {
  return {
    occurrenceId: 'occ-1',
    taskId: 'task-1',
    title: 'Write the report',
    categoryId: 'cat-1',
    start: '2026-03-23T08:00:00.000Z',
    end: '2026-03-23T09:00:00.000Z',
    cooldownMin: 0,
    ...overrides,
  };
}

function appointment(overrides: Partial<FixedBlock> = {}): FixedBlock {
  return {
    appointmentId: 'appt-1',
    title: 'Standup',
    notes: null,
    start: '2026-03-23T08:00:00.000Z',
    end: '2026-03-23T08:30:00.000Z',
    version: 1,
    occurrenceStart: null,
    isRecurring: false,
    isUnavailability: false,
    isInternal: false,
    status: 'confirmed',
    ...overrides,
  };
}

describe('positioning blocks on a day', () => {
  it('places a block by local wall clock, not by UTC', () => {
    // 08:00Z in March is 09:00 Berlin — 540 minutes down the column.
    const [block] = blocksForDay(parseCivilDate('2026-03-23'), BERLIN, [task()], []);

    expect(block).toMatchObject({ startMin: 540, endMin: 600, kind: 'task' });
    expect(block?.label).toBe('09:00–10:00');
  });

  it('keeps the same wall clock across a DST boundary', () => {
    // Berlin moves to UTC+2 on 2026-03-29. A task at 09:00 local is 08:00Z
    // before the change and 07:00Z after it, and both must sit at 540.
    const before = blocksForDay(parseCivilDate('2026-03-23'), BERLIN, [task()], []);
    const after = blocksForDay(
      parseCivilDate('2026-03-30'),
      BERLIN,
      [task({ start: '2026-03-30T07:00:00.000Z', end: '2026-03-30T08:00:00.000Z' })],
      [],
    );

    expect(after[0]?.startMin).toBe(before[0]?.startMin);
    expect(after[0]?.label).toBe('09:00–10:00');
  });

  it('leaves a block off a day it does not touch', () => {
    expect(blocksForDay(parseCivilDate('2026-03-24'), BERLIN, [task()], [])).toEqual([]);
  });

  it('shows an overnight block on both days, clipped and flagged', () => {
    // 22:00–02:00 Berlin, which is 21:00Z Monday to 01:00Z Tuesday.
    const overnight = task({
      start: '2026-03-23T21:00:00.000Z',
      end: '2026-03-24T01:00:00.000Z',
    });

    const [monday] = blocksForDay(parseCivilDate('2026-03-23'), BERLIN, [overnight], []);
    const [tuesday] = blocksForDay(parseCivilDate('2026-03-24'), BERLIN, [overnight], []);

    expect(monday).toMatchObject({ startMin: 1320, endMin: 1440, continuesAfter: true });
    expect(tuesday).toMatchObject({ startMin: 0, endMin: 120, continuesBefore: true });
  });

  it('closes a block ending at local midnight at the end of its own day', () => {
    // The half-open interval bug: 0 would collapse it onto the following day.
    const [block] = blocksForDay(
      parseCivilDate('2026-03-23'),
      BERLIN,
      [task({ start: '2026-03-23T22:00:00.000Z', end: '2026-03-23T23:00:00.000Z' })],
      [],
    );

    expect(block).toMatchObject({ startMin: 1380, endMin: 1440, continuesAfter: false });
  });

  it('labels an unavailability itself rather than rendering an empty title', () => {
    // §7.4 stores no title, deliberately. The label is the client's to supply.
    const [block] = blocksForDay(
      parseCivilDate('2026-03-23'),
      BERLIN,
      [],
      [appointment({ title: '', isUnavailability: true })],
    );

    expect(block).toMatchObject({ kind: 'unavailability', title: 'Unavailable' });
  });

  it('orders blocks by start, then deterministically', () => {
    const blocks = blocksForDay(
      parseCivilDate('2026-03-23'),
      BERLIN,
      [
        task({
          occurrenceId: 'b',
          title: 'Later',
          start: '2026-03-23T10:00:00.000Z',
          end: '2026-03-23T11:00:00.000Z',
        }),
        task({ occurrenceId: 'a', title: 'Earlier' }),
      ],
      [appointment()],
    );

    // "Earlier" and "Standup" both start at 09:00, so the title breaks the
    // tie — deterministically, whatever order the API happened to return.
    expect(blocks.map((block) => block.title)).toEqual(['Earlier', 'Standup', 'Later']);
  });
});

describe('the week the grid draws', () => {
  it('starts on the user first day of week (§13)', () => {
    const monday = weekDays(parseCivilDate('2026-03-25'), 1);
    expect(monday[0]).toEqual(parseCivilDate('2026-03-23'));
    expect(monday).toHaveLength(7);

    const sunday = weekDays(parseCivilDate('2026-03-25'), 7);
    expect(sunday[0]).toEqual(parseCivilDate('2026-03-22'));
  });
});

describe('minuteOfDay', () => {
  it('is measured from local midnight, in the calendar zone', () => {
    expect(minuteOfDay('2026-03-23T08:00:00.000Z', BERLIN)).toBe(540);
    expect(minuteOfDay('2026-03-23T08:00:00.000Z', 'UTC')).toBe(480);
    // A viewer's own zone is irrelevant: the calendar's is what is drawn.
    expect(minuteOfDay('2026-03-23T08:00:00.000Z', 'America/New_York')).toBe(240);
  });
});

/**
 * The drag grid of spec §13: "UI drag grid snaps to 15-minute blocks; a text
 * field allows exact minutes."
 *
 * Arithmetic, so it is tested as arithmetic — the component only has to render
 * what these return, and a wrong answer here would be a task rescheduled to a
 * time nobody asked for.
 */
describe('drag arithmetic', () => {
  it('snaps to the nearest quarter hour', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(7)).toBe(0);
    expect(snapToGrid(8)).toBe(15);
    expect(snapToGrid(22)).toBe(15);
    expect(snapToGrid(23)).toBe(30);
    expect(snapToGrid(-8)).toBe(-15);
  });

  it('converts a pixel delta through the same scale the layout uses', () => {
    // SCALE is exported rather than duplicated, so a change to the row height
    // cannot make a drop land somewhere other than where it was dropped.
    expect(dragOffsetMinutes(SCALE * 60)).toBe(60);
    expect(dragOffsetMinutes(SCALE * 8)).toBe(15);
    expect(dragOffsetMinutes(-SCALE * 30)).toBe(-30);
  });

  it('clamps a move to the day it was dragged on', () => {
    // 08:00–09:00 UTC, drawn on a UTC calendar: 480 to 540 local minutes.
    const day = parseCivilDate('2026-03-23');
    const [drawn] = blocksForDay(day, 'UTC', [task()], []);

    expect(movedStartMin(drawn!, 120)).toBe(10 * 60);

    // Dragged off the top: the user was reaching for the start of the day and
    // overshot. Rescheduling it to the previous day would be a surprising
    // answer to a slip of the hand.
    expect(movedStartMin(drawn!, -600, 6 * 60)).toBe(6 * 60);

    // And off the bottom, where a one-hour block can start no later than 23:00.
    expect(movedStartMin(drawn!, 10_000)).toBe(23 * 60);
  });
});
