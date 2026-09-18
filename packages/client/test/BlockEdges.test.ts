import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { CalendarConfiguration, FixedBlock, ScheduledBlock } from '@ambitime/shared';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import { DEFAULT_SCALE } from '@/lib/grid';
import { parseCivilDate, weekDays } from '@/lib/time';

/**
 * A block is one object, and you can see where it stops (spec §6.1, §7.2).
 *
 * Two separate ways the grid used to lose that. A block's border was set to the
 * *same value as its fill*, so two hours of Work followed by two more were one
 * four-hour shape — the colour said which activity type and nothing said how
 * many things. And an unavailability was `bg-muted` on a day body that is also
 * `bg-muted`, drawn from the top of the day rather than the top of the hours on
 * screen: blocking out a day covered the lit part of the column and clipped its
 * own label off above the grid, which is a change a reader can only notice by
 * remembering what was there a second ago.
 */

const BERLIN = 'Europe/Berlin';
const WEEK = weekDays(parseCivilDate('2026-03-23'), 1);

const activityTypes = [
  { id: 'cat-work', name: 'Work', defaultCooldownMin: 0, color: 'blue', version: 1 },
  { id: 'cat-old', name: 'Legacy', defaultCooldownMin: 0, color: null, version: 1 },
] as CalendarConfiguration['activityTypes'];

function task(
  id: string,
  activityTypeId: string,
  fromHour: number,
  toHour: number,
): ScheduledBlock {
  return {
    occurrenceId: `occ-${id}`,
    taskId: `task-${id}`,
    title: id,
    activityTypeId,
    start: `2026-03-23T${String(fromHour).padStart(2, '0')}:00:00.000Z`,
    end: `2026-03-23T${String(toHour).padStart(2, '0')}:00:00.000Z`,
    cooldownMin: 0,
  };
}

/** A whole Berlin day closed, which is the shape `BlockOutDay` writes (§7.2). */
const wholeDay: FixedBlock = {
  appointmentId: 'appt-off',
  title: '',
  notes: null,
  start: '2026-03-22T23:00:00.000Z',
  end: '2026-03-23T23:00:00.000Z',
  version: 1,
  occurrenceStart: null,
  isRecurring: false,
  isUnavailability: true,
  cooldownMin: 0,
  isInternal: false,
  status: 'confirmed',
};

function week(blocks: ScheduledBlock[] = [], fixedBlocks: FixedBlock[] = []) {
  return mount(WeekGrid, {
    props: { days: WEEK, timeZone: BERLIN, blocks, fixedBlocks, activityTypes },
  });
}

describe('where one block stops and the next begins', () => {
  it('draws a task in a line that is not its own fill', () => {
    const style = week([task('One', 'cat-work', 8, 9)])
      .find('[data-testid="block-task"]')
      .attributes('style');

    expect(style).toContain('background-color: var(--activity-type-block-blue)');
    // The border is the fill stepped down towards the page's deep neutral.
    // Written out rather than matched loosely: the mix ratio is the measured
    // part — 60% is ΔE 13 or better on all sixteen steps, and a later edit that
    // softened it would pass a `toContain('color-mix')`.
    expect(style).toContain(
      'border-color: color-mix(in oklab, var(--activity-type-block-blue) 60%, var(--block-edge))',
    );
  });

  it('gives two touching blocks of one type an edge each', () => {
    // The case the border exists for: same hue, no gap, nothing else to
    // separate them. Before, this was one box from nine until one.
    const wrapper = week([task('One', 'cat-work', 8, 10), task('Two', 'cat-work', 10, 12)]);
    const styles = wrapper
      .findAll('[data-testid="block-task"]')
      .map((block) => block.attributes('style') ?? '');

    expect(styles).toHaveLength(2);
    for (const style of styles) expect(style).toContain('var(--block-edge)');
  });

  it('takes the neutral block’s edge from its ink instead', () => {
    // `--primary` on the light surface *is* the deep neutral, so stepping it
    // towards that would draw nothing. The ink is the only direction left.
    const block = week([task('One', 'cat-old', 8, 9)]).find('[data-testid="block-task"]');

    expect(block.classes()).toContain('border-primary-foreground/30');
    expect(block.attributes('style') ?? '').not.toContain('border-color');
  });
});

describe('a day that has been blocked out', () => {
  it('is hatched, so it reads as covered rather than as empty', () => {
    // The fill is the day body's own colour, measured: without the texture the
    // only signal is the lit part of the column going out.
    expect(week([], [wholeDay]).find('[data-testid="block-unavailability"]').classes()).toContain(
      'hatched',
    );
  });

  it('says so in the month with the same texture', () => {
    const wrapper = mount(MonthGrid, {
      props: {
        month: parseCivilDate('2026-03-01'),
        timeZone: BERLIN,
        firstDayOfWeek: 1,
        fixedBlocks: [wholeDay],
      },
    });

    expect(wrapper.find('[data-testid="month-block-unavailability"]').classes()).toContain(
      'hatched',
    );
  });

  it('keeps its label inside the hours on screen', () => {
    // 00:00 against a grid that opens at 06:00 put the box 396 pixels above the
    // top edge, and the word "Unavailable" with it. The bottom edge does not
    // move: what comes off the top is added back to the height.
    const style = week([], [wholeDay])
      .find('[data-testid="block-unavailability"]')
      .attributes('style');

    expect(style).toContain('top: 0px');
    // Summed the way the component sums it, so the float lands identically.
    expect(style).toContain(`height: ${1440 * DEFAULT_SCALE - 6 * 60 * DEFAULT_SCALE}px`);
  });

  it('leaves a block that starts inside the band where it was', () => {
    const style = week([task('One', 'cat-work', 8, 9)])
      .find('[data-testid="block-task"]')
      .attributes('style');

    // 09:00 Berlin, three hours past the 06:00 the grid opens at.
    expect(style).toContain(`top: ${3 * 60 * DEFAULT_SCALE}px`);
    expect(style).toContain(`height: ${60 * DEFAULT_SCALE}px`);
  });
});
