import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS, nextCategoryColor } from '@ambitime/shared';
import { categoryLanesForDay } from '@/lib/grid';
import type { ResolvedWindow } from '@ambitime/scheduler';

/**
 * Activity types, drawn where they may be scheduled (spec §4.3).
 *
 * The week used to shade one neutral band meaning "something could go here",
 * which answers a question nobody has. What a person wants to know is *what
 * kind of thing* fits, and that needs the categories kept apart rather than
 * unioned — which is the whole of what these lanes are.
 */

const ZONE = 'Europe/Berlin';
const MONDAY = { year: 2026, month: 3, day: 23 };

/** A window for `categoryId`, given as Berlin wall-clock hours. */
function window(categoryId: string, fromHour: number, toHour: number): ResolvedWindow {
  const at = (hour: number) => Date.UTC(2026, 2, 23, hour - 1) / 60_000;
  return {
    ruleId: `${categoryId}-${fromHour}`,
    calendarId: 'cal',
    categoryId,
    interval: { start: at(fromHour), end: at(toHour) },
  };
}

describe('splitting a day by activity type', () => {
  it('gives a lone type the whole width', () => {
    const lanes = categoryLanesForDay(MONDAY, ZONE, [window('work', 9, 17)]);

    expect(lanes).toEqual([
      { categoryId: 'work', startMin: 540, endMin: 1020, offset: 0, width: 1 },
    ]);
  });

  it('splits the width where two types overlap, and only there', () => {
    // Work all morning, exercise over the middle of it.
    const lanes = categoryLanesForDay(MONDAY, ZONE, [
      window('work', 9, 17),
      window('exercise', 12, 14),
    ]);

    // Three segments: work alone, both, work alone again.
    expect(lanes.map((lane) => [lane.categoryId, lane.startMin, lane.endMin, lane.width])).toEqual([
      ['work', 540, 720, 1],
      ['exercise', 720, 840, 0.5],
      ['work', 720, 840, 0.5],
      ['work', 840, 1020, 1],
    ]);
  });

  it('keeps every hue as chosen rather than blending them', () => {
    // The reason for lanes rather than stacked translucency: two fills over one
    // another make a third colour that is in no palette and means nothing.
    const lanes = categoryLanesForDay(MONDAY, ZONE, [
      window('a', 9, 12),
      window('b', 9, 12),
      window('c', 9, 12),
    ]);

    expect(lanes).toHaveLength(3);
    expect(lanes.map((lane) => lane.width)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(lanes.map((lane) => lane.offset)).toEqual([0, 1 / 3, 2 / 3]);
    // No gaps and no overlap: the three together are exactly the column.
    expect(lanes.at(-1)!.offset + lanes.at(-1)!.width).toBeCloseTo(1);
  });

  it('merges two windows of one type into one lane', () => {
    // "09:00–12:00 and 12:00–17:00" is one working day; a seam at noon would
    // read as a break that is not there.
    const lanes = categoryLanesForDay(MONDAY, ZONE, [
      window('work', 9, 12),
      window('work', 12, 17),
    ]);

    expect(lanes).toEqual([
      { categoryId: 'work', startMin: 540, endMin: 1020, offset: 0, width: 1 },
    ]);
  });

  it('orders lanes the same way every time', () => {
    // Otherwise a type moves sideways as you page through weeks, which reads as
    // the schedule changing (§6.3).
    const windows = [window('zeta', 9, 17), window('alpha', 9, 17)];

    const forwards = categoryLanesForDay(MONDAY, ZONE, windows);
    const backwards = categoryLanesForDay(MONDAY, ZONE, [...windows].reverse());

    expect(forwards).toEqual(backwards);
    expect(forwards.map((lane) => lane.categoryId)).toEqual(['alpha', 'zeta']);
  });

  it('draws nothing for a day the windows miss', () => {
    expect(
      categoryLanesForDay({ year: 2026, month: 3, day: 24 }, ZONE, [window('work', 9, 17)]),
    ).toEqual([]);
  });
});

describe('assigning a colour', () => {
  it('walks the palette in order', () => {
    // The first three slots are the ones that separate for every reader, so the
    // order is what makes three activity types legible without anyone choosing.
    expect(nextCategoryColor([])).toBe('blue');
    expect(nextCategoryColor(['blue'])).toBe('orange');
    expect(nextCategoryColor(['blue', 'orange'])).toBe('aqua');
  });

  it('skips what is taken rather than counting', () => {
    // A user who recoloured the second type leaves a gap; the next one fills it.
    expect(nextCategoryColor(['blue', 'aqua'])).toBe('orange');
  });

  it('runs out rather than cycling', () => {
    // Two types the same colour is a statement that they are related, and the
    // ninth is not related to the first.
    expect(nextCategoryColor([...CATEGORY_COLORS])).toBeNull();
  });

  it('ignores types that have no colour', () => {
    expect(nextCategoryColor([null, null])).toBe('blue');
  });
});
