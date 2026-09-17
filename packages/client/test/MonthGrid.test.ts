import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { ScheduledBlock } from '@ambitime/shared';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import { parseCivilDate } from '@/lib/time';

/**
 * Reading a month without leaving it (spec §4.3, §6.1).
 *
 * The month view answers "what shape are the next few weeks", and it did that
 * by listing three things per day and counting the rest — so on any day that
 * actually mattered the answer was "+7 more", and the only way to read those
 * seven was to navigate into the week and back out. Two gestures fix it, and
 * both are ones somebody makes anyway while reading down a month: pointing at a
 * day shows everything on it, and clicking a day opens its hours.
 */

const BERLIN = 'Europe/Berlin';
/** March 2026 begins on a Sunday, so the grid is six rows: 23 Feb – 5 Apr. */
const MARCH = parseCivilDate('2026-03-01');

function task(n: number, day: string): ScheduledBlock {
  return {
    occurrenceId: `occ-${day}-${n}`,
    taskId: `task-${day}-${n}`,
    title: `Task ${n}`,
    categoryId: null,
    start: `${day}T09:00:00.000Z`,
    end: `${day}T10:00:00.000Z`,
    cooldownMin: 0,
  };
}

/** `count` things on `day`, which is how a cell runs out of room. */
function pileOn(day: string, count: number): ScheduledBlock[] {
  return Array.from({ length: count }, (_, index) => task(index + 1, day));
}

function month(blocks: ScheduledBlock[]) {
  return mount(MonthGrid, {
    props: { month: MARCH, timeZone: BERLIN, firstDayOfWeek: 1, blocks },
  });
}

const cellFor = (wrapper: ReturnType<typeof month>, date: string) =>
  wrapper.get(`[data-testid="month-day"][data-date="${date}"]`);

const titlesIn = (cell: ReturnType<typeof cellFor>) =>
  cell.findAll('[data-testid="month-block-task"]').map((entry) => entry.text());

describe('a day with more on it than fits', () => {
  it('counts what it is not showing', () => {
    const cell = cellFor(month(pileOn('2026-03-10', 7)), '2026-03-10');

    expect(titlesIn(cell)).toHaveLength(3);
    expect(cell.get('[data-testid="month-day-more"]').text()).toBe('+4 more');
  });

  it('shows all of it when it is pointed at', async () => {
    const wrapper = month(pileOn('2026-03-10', 7));
    const cell = cellFor(wrapper, '2026-03-10');

    await cell.trigger('pointerenter');

    expect(titlesIn(cellFor(wrapper, '2026-03-10'))).toHaveLength(7);
    // The count is gone because it is no longer counting anything.
    expect(cellFor(wrapper, '2026-03-10').find('[data-testid="month-day-more"]').exists()).toBe(
      false,
    );
  });

  it('floats the list rather than growing the row', async () => {
    // In flow it would push every cell under it down the page, so reaching for
    // the fourth item on the 10th would move the 10th.
    const wrapper = month(pileOn('2026-03-10', 7));
    await cellFor(wrapper, '2026-03-10').trigger('pointerenter');

    const list = cellFor(wrapper, '2026-03-10').get('[data-testid="month-day-list"]');
    expect(list.classes()).toContain('absolute');
    expect(list.classes()).toContain('top-7');
  });

  it('opens upward from the last rows, which the grid would clip', async () => {
    // 2026-04-02 is in the sixth and final row of a March grid.
    const wrapper = month(pileOn('2026-04-02', 7));
    await cellFor(wrapper, '2026-04-02').trigger('pointerenter');

    const list = cellFor(wrapper, '2026-04-02').get('[data-testid="month-day-list"]');
    expect(list.classes()).toContain('bottom-1');
    expect(list.classes()).not.toContain('top-7');
  });

  it('closes again when the pointer goes elsewhere', async () => {
    const wrapper = month(pileOn('2026-03-10', 7));
    await cellFor(wrapper, '2026-03-10').trigger('pointerenter');
    await cellFor(wrapper, '2026-03-10').trigger('pointerleave');

    expect(titlesIn(cellFor(wrapper, '2026-03-10'))).toHaveLength(3);
  });

  it('leaves a day that fits alone', async () => {
    const wrapper = month(pileOn('2026-03-10', 2));
    await cellFor(wrapper, '2026-03-10').trigger('pointerenter');

    // Nothing hidden, so nothing to open: a panel here would be a box appearing
    // over the grid to show what was already on it.
    const list = cellFor(wrapper, '2026-03-10').get('[data-testid="month-day-list"]');
    expect(list.classes()).not.toContain('absolute');
  });
});

describe('opening a day', () => {
  it('goes to the hours from anywhere in the cell', async () => {
    const wrapper = month([]);

    await cellFor(wrapper, '2026-03-10').trigger('click');

    expect(wrapper.emitted('openDay')).toEqual([[parseCivilDate('2026-03-10')]]);
  });

  it('goes there once, not twice, from the day number', async () => {
    // The number is the keyboard path and the cell is the accelerator; without
    // the click being stopped, pressing the one inside the other would fire
    // both handlers.
    const wrapper = month([]);

    await cellFor(wrapper, '2026-03-10').get('[data-testid="open-day"]').trigger('click');

    expect(wrapper.emitted('openDay')).toHaveLength(1);
  });

  it('opens the day a leading or trailing cell belongs to', async () => {
    // The last days of February are drawn while you are looking at March, and
    // they are days like any other.
    const wrapper = month([]);

    await cellFor(wrapper, '2026-02-24').trigger('click');

    expect(wrapper.emitted('openDay')).toEqual([[parseCivilDate('2026-02-24')]]);
  });
});
