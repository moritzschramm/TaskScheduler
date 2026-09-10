import { describe, expect, it } from 'vitest';
import type { CalendarConfiguration, FixedBlock, ScheduledBlock } from '@ambitime/shared';
import type { ResolvedWindow } from '@ambitime/scheduler';
import {
  assignLanes,
  blocksForDay,
  clipBand,
  dragOffsetMinutes,
  movedStartMin,
  openBandsForDay,
  DEFAULT_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  setScale,
  slotAtOffset,
  snapToGrid,
  windowsForWeek,
  type GridBlock,
} from '@/lib/grid';
import { minuteOfDay, parseCivilDate, toInstant, weekDays } from '@/lib/time';

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
    // The scale is read through `lib/grid` rather than duplicated, so a change
    // cannot make a drop land somewhere other than where it was dropped.
    expect(dragOffsetMinutes(DEFAULT_SCALE * 60)).toBe(60);
    expect(dragOffsetMinutes(DEFAULT_SCALE * 8)).toBe(15);
    expect(dragOffsetMinutes(-DEFAULT_SCALE * 30)).toBe(-30);
  });

  it('follows the row height when the user changes it', () => {
    // The slider moves the scale; the drag arithmetic has to move with it, or a
    // drop lands on a different hour from the one it looked like.
    try {
      setScale(2);
      expect(dragOffsetMinutes(2 * 60)).toBe(60);
      // Clamped rather than trusted: nothing may put the grid outside its bounds.
      expect(setScale(99)).toBe(MAX_SCALE);
      expect(setScale(0)).toBe(MIN_SCALE);
    } finally {
      setScale(DEFAULT_SCALE);
    }
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

/**
 * The shading behind the blocks (spec §4.3, §9.1).
 *
 * The bug these are written against was an empty grid that looked exactly like
 * a full one with nothing on it. A calendar whose columns are uniformly blank
 * cannot tell you that it has nowhere to put anything, which is precisely the
 * state a new calendar is in and precisely the state that needs saying.
 */
function window_(startIso: string, endIso: string, categoryId = 'cat-1'): ResolvedWindow {
  return {
    ruleId: `rule-${categoryId}`,
    calendarId: 'cal-1',
    categoryId,
    interval: { start: toInstant(startIso), end: toInstant(endIso) },
  };
}

describe('the hours a day is open', () => {
  const MONDAY = parseCivilDate('2026-03-23');

  it('reads a window in local minutes, like everything else on the grid', () => {
    // 08:00Z–16:00Z in March is 09:00–17:00 Berlin.
    const bands = openBandsForDay(MONDAY, BERLIN, [
      window_('2026-03-23T08:00:00.000Z', '2026-03-23T16:00:00.000Z'),
    ]);

    expect(bands).toEqual([{ startMin: 540, endMin: 1020 }]);
  });

  it('ignores a window belonging to another day', () => {
    const bands = openBandsForDay(MONDAY, BERLIN, [
      window_('2026-03-24T08:00:00.000Z', '2026-03-24T16:00:00.000Z'),
    ]);

    expect(bands).toEqual([]);
  });

  it('merges two categories into one band where they overlap', () => {
    // Otherwise the overlap is painted twice, and a translucent fill painted
    // twice is a different colour — a seam where the day is most available.
    const bands = openBandsForDay(MONDAY, BERLIN, [
      window_('2026-03-23T08:00:00.000Z', '2026-03-23T12:00:00.000Z', 'work'),
      window_('2026-03-23T10:00:00.000Z', '2026-03-23T16:00:00.000Z', 'admin'),
    ]);

    expect(bands).toEqual([{ startMin: 540, endMin: 1020 }]);
  });

  it('joins two that merely touch', () => {
    // 09:00–12:00 then 12:00–17:00 is one working day. A seam drawn at noon
    // would read as a break that nobody configured.
    const bands = openBandsForDay(MONDAY, BERLIN, [
      window_('2026-03-23T08:00:00.000Z', '2026-03-23T11:00:00.000Z', 'work'),
      window_('2026-03-23T11:00:00.000Z', '2026-03-23T16:00:00.000Z', 'admin'),
    ]);

    expect(bands).toEqual([{ startMin: 540, endMin: 1020 }]);
  });

  it('keeps a genuine gap as two bands', () => {
    const bands = openBandsForDay(MONDAY, BERLIN, [
      window_('2026-03-23T08:00:00.000Z', '2026-03-23T11:00:00.000Z', 'work'),
      window_('2026-03-23T12:00:00.000Z', '2026-03-23T16:00:00.000Z', 'admin'),
    ]);

    expect(bands).toEqual([
      { startMin: 540, endMin: 720 },
      { startMin: 780, endMin: 1020 },
    ]);
  });

  it('answers an unconfigured calendar with a closed day', () => {
    // Not an edge case: it is what every calendar looks like before anyone has
    // been to settings, and the grid has to be able to draw it.
    expect(openBandsForDay(MONDAY, BERLIN, [])).toEqual([]);
  });

  it('clips a band to the span the grid actually draws', () => {
    // A window from midnight would otherwise be positioned at a negative
    // offset and paint over the day headings.
    expect(clipBand({ startMin: 0, endMin: 1440 }, 360, 1320)).toEqual({
      startMin: 360,
      endMin: 1320,
    });
    expect(clipBand({ startMin: 540, endMin: 1020 }, 360, 1320)).toEqual({
      startMin: 540,
      endMin: 1020,
    });
    expect(clipBand({ startMin: 0, endMin: 300 }, 360, 1320)).toBeNull();
  });
});

/**
 * Which windows the grid draws (spec §3.3, §4.3, §9.1).
 *
 * The first version of this shaded from the schedule context's own windows,
 * which are resolved against the *placeable* horizon — it starts at `now`. That
 * drew this morning as closed because it had passed, and every week the user
 * paged back to as closed entirely. Neither is a fact about the calendar.
 */
function configuration(overrides: Partial<CalendarConfiguration> = {}): CalendarConfiguration {
  return {
    calendar: {
      id: 'cal-1',
      name: 'Primary',
      timezone: BERLIN,
      visibilityScope: 'private',
      version: 1,
      isOwner: true,
    },
    windows: [],
    categories: [{ id: 'cat-1', name: 'Work', defaultCooldownMin: 0, color: null, version: 1 }],
    availability: [
      {
        id: 'win-1',
        categoryId: 'cat-1',
        weekTypeOverrideId: null,
        focusLevel: null,
        weekday: 1,
        startMin: 9 * 60,
        endMin: 17 * 60,
      },
    ],
    weekTypeOverrides: [],
    ...overrides,
  };
}

describe('the windows behind the week on screen', () => {
  const THIS_WEEK = weekDays(parseCivilDate('2026-03-23'), 1);
  const LAST_YEAR = weekDays(parseCivilDate('2025-03-24'), 1);

  it('expands a weekday rule onto the Monday being drawn', () => {
    const resolved = windowsForWeek(THIS_WEEK, BERLIN, 'cal-1', configuration());

    expect(openBandsForDay(THIS_WEEK[0]!, BERLIN, resolved)).toEqual([
      { startMin: 540, endMin: 1020 },
    ]);
  });

  it('draws a week in the past exactly the same', () => {
    // The rules have no horizon. A week already gone is still a week whose
    // Monday mornings were working hours, and paging back must not black it out.
    const resolved = windowsForWeek(LAST_YEAR, BERLIN, 'cal-1', configuration());

    expect(openBandsForDay(LAST_YEAR[0]!, BERLIN, resolved)).toEqual([
      { startMin: 540, endMin: 1020 },
    ]);
  });

  it('lets the working window clip the category window', () => {
    // §9.1: the calendar says when tasks may be placed at all, and it wins.
    const resolved = windowsForWeek(
      THIS_WEEK,
      BERLIN,
      'cal-1',
      configuration({
        windows: [{ id: 'cw-1', kind: 'working', weekday: 1, startMin: 780, endMin: 1080 }],
      }),
    );

    expect(openBandsForDay(THIS_WEEK[0]!, BERLIN, resolved)).toEqual([
      { startMin: 780, endMin: 1020 },
    ]);
  });

  it('treats no working window as unrestricted, not as closed', () => {
    // `[]` would mean "nothing may be placed anywhere", which is a setting
    // nobody made — and it would shade every calendar closed until someone did.
    const resolved = windowsForWeek(THIS_WEEK, BERLIN, 'cal-1', configuration({ windows: [] }));

    expect(openBandsForDay(THIS_WEEK[0]!, BERLIN, resolved)).toHaveLength(1);
  });

  it('closes a week a week-type override has emptied', () => {
    const resolved = windowsForWeek(
      THIS_WEEK,
      BERLIN,
      'cal-1',
      configuration({
        weekTypeOverrides: [
          { id: 'ov-1', name: 'Leave', startDate: '2026-03-23', endDate: '2026-03-30', version: 1 },
        ],
      }),
    );

    // The override replaces the default set entirely (§4.3), and it has no
    // windows of its own — so the week really is shut.
    expect(resolved).toEqual([]);
  });

  it('answers an empty week with no windows rather than throwing', () => {
    expect(windowsForWeek([], BERLIN, 'cal-1', configuration())).toEqual([]);
  });
});

/**
 * What was done stays where it was done (spec §3.4, §7.3).
 *
 * A completed occurrence is not demand, so the solver never places it and the
 * derived schedule cannot contain it — correct for scheduling, and the reason
 * the block used to vanish from the week it was spent in. These arrive beside
 * the placements rather than among them, because an optimistic client-side
 * solve would otherwise disagree with the server on every read.
 */
describe('blocks that are already finished', () => {
  const MONDAY = parseCivilDate('2026-03-23');

  const done = {
    occurrenceId: 'occ-9',
    taskId: 'task-9',
    title: 'Wrote the report',
    categoryId: 'cat-1',
    start: '2026-03-23T08:00:00.000Z',
    end: '2026-03-23T09:30:00.000Z',
    completedAt: '2026-03-23T09:30:00.000Z',
  };

  it('is positioned by the same local clock as everything else', () => {
    const [block] = blocksForDay(MONDAY, BERLIN, [], [], [done]);

    expect(block).toMatchObject({ kind: 'completed', startMin: 540, endMin: 630 });
    expect(block?.taskId).toBe('task-9');
  });

  it('reserves no cooldown, because the time is already given back', () => {
    const [block] = blocksForDay(MONDAY, BERLIN, [], [], [done]);
    expect(block?.cooldownMin).toBe(0);
  });

  it('sorts among the day rather than after it', () => {
    // Drawn in clock order with everything else: a finished morning and a
    // scheduled afternoon read as one day, which is the point of keeping it.
    const later = task({ start: '2026-03-23T13:00:00.000Z', end: '2026-03-23T14:00:00.000Z' });
    const blocks = blocksForDay(MONDAY, BERLIN, [later], [], [done]);

    expect(blocks.map((block) => block.kind)).toEqual(['completed', 'task']);
  });

  it('is absent from a day it does not touch', () => {
    expect(blocksForDay(parseCivilDate('2026-03-24'), BERLIN, [], [], [done])).toEqual([]);
  });
});

describe('blocks that occupy the same minutes', () => {
  function block(overrides: Partial<GridBlock> = {}): GridBlock {
    return {
      key: 'k',
      title: 'Block',
      startMin: 540,
      endMin: 600,
      cooldownMin: 0,
      kind: 'appointment',
      label: '09:00–10:00',
      continuesBefore: false,
      continuesAfter: false,
      ...overrides,
    };
  }

  it('gives a block on its own the whole column', () => {
    expect(assignLanes([block()])).toMatchObject([{ lane: 0, lanes: 1 }]);
  });

  it('splits the column between two that overlap', () => {
    const placed = assignLanes([
      block({ key: 'a', startMin: 540, endMin: 660 }),
      block({ key: 'b', startMin: 600, endMin: 720 }),
    ]);

    expect(placed).toMatchObject([
      { key: 'a', lane: 0, lanes: 2 },
      { key: 'b', lane: 1, lanes: 2 },
    ]);
  });

  it('leaves two that merely touch at full width', () => {
    // Half-open again: 09:00–10:00 and 10:00–11:00 are one after the other,
    // and halving the column would say they were happening at once.
    const placed = assignLanes([
      block({ key: 'a', startMin: 540, endMin: 600 }),
      block({ key: 'b', startMin: 600, endMin: 660 }),
    ]);

    expect(placed).toMatchObject([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
    ]);
  });

  it('reuses a lane once its occupant has ended', () => {
    // A long block beside two short ones in sequence: two lanes, not three.
    // The width comes from the busiest instant, not from the count.
    const placed = assignLanes([
      block({ key: 'all-day', startMin: 540, endMin: 1020 }),
      block({ key: 'first', startMin: 600, endMin: 660 }),
      block({ key: 'second', startMin: 720, endMin: 780 }),
    ]);

    expect(placed).toMatchObject([
      { key: 'all-day', lane: 0, lanes: 2 },
      { key: 'first', lane: 1, lanes: 2 },
      { key: 'second', lane: 1, lanes: 2 },
    ]);
  });

  it('holds one width across a chain, even where the ends do not meet', () => {
    // A overlaps B and B overlaps C while A and C are an hour apart. All three
    // share one width regardless — two widths in a cluster would not add up to
    // a column — and C takes the lane A has finished with, so the column is
    // halved rather than cut in three.
    const placed = assignLanes([
      block({ key: 'a', startMin: 540, endMin: 660 }),
      block({ key: 'b', startMin: 600, endMin: 780 }),
      block({ key: 'c', startMin: 720, endMin: 840 }),
    ]);

    expect(placed.map((entry) => entry.lanes)).toEqual([2, 2, 2]);
    expect(placed.map((entry) => entry.lane)).toEqual([0, 1, 0]);
  });

  it('lays out two independent clusters independently', () => {
    const placed = assignLanes([
      block({ key: 'morning-a', startMin: 540, endMin: 600 }),
      block({ key: 'morning-b', startMin: 550, endMin: 610 }),
      block({ key: 'afternoon', startMin: 840, endMin: 900 }),
    ]);

    expect(placed.map((entry) => entry.lanes)).toEqual([2, 2, 1]);
  });
});

describe('the slot a click landed in', () => {
  it('floors to the quarter hour the pointer was inside', () => {
    // 14:07 is a click inside two o'clock. Rounding it to 14:15 would open a
    // form on a quarter of an hour the user had not reached yet.
    expect(slotAtOffset(7, 14 * 60, 22 * 60, 1)).toBe(14 * 60);
    expect(slotAtOffset(16, 14 * 60, 22 * 60, 1)).toBe(14 * 60 + 15);
  });

  it('reads the offset through the scale', () => {
    // The same pixel is a different minute at a different row height, which is
    // the whole reason the scale is passed in rather than assumed.
    expect(slotAtOffset(60, 6 * 60, 22 * 60, 2)).toBe(6 * 60 + 30);
    expect(slotAtOffset(60, 6 * 60, 22 * 60, 0.5)).toBe(8 * 60);
  });

  it('cannot land outside the visible span', () => {
    expect(slotAtOffset(-40, 6 * 60, 22 * 60, 1)).toBe(6 * 60);
    // A slot at the very bottom would be a block with no room to be drawn in.
    expect(slotAtOffset(10_000, 6 * 60, 22 * 60, 1)).toBe(22 * 60 - 15);
  });
});
