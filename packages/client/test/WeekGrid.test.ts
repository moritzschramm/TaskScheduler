import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { FixedBlock, ScheduledBlock } from '@ambitime/shared';
import type { ResolvedWindow } from '@ambitime/scheduler';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import { parseCivilDate, toInstant, weekDays } from '@/lib/time';

/**
 * Rendering the week (plan M10's review focus: grid correctness, timezones).
 *
 * The arithmetic is covered in `grid.test.ts`; what is under test here is that
 * the component puts the result on screen — the right block in the right
 * column, positioned by the *calendar's* zone rather than the machine running
 * the test.
 */

const BERLIN = 'Europe/Berlin';
const WEEK = weekDays(parseCivilDate('2026-03-23'), 1);

const block: ScheduledBlock = {
  occurrenceId: 'occ-1',
  taskId: 'task-1',
  title: 'Write the report',
  categoryId: 'cat-1',
  start: '2026-03-24T08:00:00.000Z',
  end: '2026-03-24T09:00:00.000Z',
  cooldownMin: 0,
};

const standup: FixedBlock = {
  appointmentId: 'appt-1',
  title: 'Standup',
  notes: null,
  start: '2026-03-23T08:00:00.000Z',
  end: '2026-03-23T08:30:00.000Z',
  version: 1,
  occurrenceStart: null,
  isRecurring: false,
  isUnavailability: false,
  isInternal: true,
  status: 'confirmed',
};

function render(blocks: ScheduledBlock[] = [block], fixedBlocks: FixedBlock[] = [standup]) {
  return mount(WeekGrid, {
    props: { days: WEEK, timeZone: BERLIN, blocks, fixedBlocks },
  });
}

describe('WeekGrid', () => {
  it('draws seven day columns starting on the week first day', () => {
    const columns = render().findAll('[data-testid="day-column"]');

    expect(columns).toHaveLength(7);
    expect(columns[0]?.attributes('data-day')).toBe('2026-03-23');
    expect(columns[6]?.attributes('data-day')).toBe('2026-03-29');
  });

  it('puts a task in the column of its local day', () => {
    const wrapper = render();
    const tuesday = wrapper.findAll('[data-testid="day-column"]')[1];

    const task = tuesday?.find('[data-testid="block-task"]');
    expect(task?.attributes('data-title')).toBe('Write the report');
    // 08:00Z is 09:00 Berlin: 540 minutes down.
    expect(task?.attributes('data-start-min')).toBe('540');
    expect(task?.attributes('data-end-min')).toBe('600');
  });

  it('does not draw a task on a day it does not touch', () => {
    const wrapper = render();
    const monday = wrapper.findAll('[data-testid="day-column"]')[0];

    expect(monday?.find('[data-testid="block-task"]').exists()).toBe(false);
    expect(monday?.find('[data-testid="block-appointment"]').exists()).toBe(true);
  });

  it('distinguishes appointments from unavailability', () => {
    const wrapper = render(
      [],
      [
        standup,
        {
          ...standup,
          appointmentId: 'appt-2',
          title: '',
          isUnavailability: true,
          start: '2026-03-23T13:00:00.000Z',
          end: '2026-03-23T15:00:00.000Z',
        },
      ],
    );

    expect(wrapper.findAll('[data-testid="block-appointment"]')).toHaveLength(1);
    const unavailable = wrapper.find('[data-testid="block-unavailability"]');
    // §7.4 stores no title; the label is the client's.
    expect(unavailable.attributes('data-title')).toBe('Unavailable');
  });

  it('positions by the calendar zone, not the viewer one', () => {
    const utc = mount(WeekGrid, {
      props: { days: WEEK, timeZone: 'UTC', blocks: [block], fixedBlocks: [] },
    });

    const berlin = render([block], []);

    expect(berlin.find('[data-testid="block-task"]').attributes('data-start-min')).toBe('540');
    expect(utc.find('[data-testid="block-task"]').attributes('data-start-min')).toBe('480');
  });

  it('renders an hour axis the columns share', () => {
    const wrapper = render();

    // One axis, labelled once; every column reads against it.
    expect(wrapper.text()).toContain('09:00');
    expect(wrapper.text()).toContain('21:00');
  });
});

/**
 * The week has to look like a week (spec §4.3, §9.1, §13).
 *
 * Two separate failures met here. The grid drew every hour identically, so an
 * unschedulable week was indistinguishable from an idle one; and its scroll
 * container grew a second vertical scrollbar inside the page's own, because a
 * box with `overflow-x` set computes a visible `overflow-y` to `auto` and the
 * last hour label hangs a few pixels below the grid.
 */
const OPEN_MONDAY: ResolvedWindow = {
  ruleId: 'rule-1',
  calendarId: 'cal-1',
  categoryId: 'cat-1',
  // 09:00–17:00 Berlin, on the Monday of the week under test.
  interval: {
    start: toInstant('2026-03-23T08:00:00.000Z'),
    end: toInstant('2026-03-23T16:00:00.000Z'),
  },
};

describe('the hours the calendar is open', () => {
  it('lights the window and leaves the rest of the day closed', () => {
    const wrapper = mount(WeekGrid, {
      props: { days: WEEK, timeZone: BERLIN, blocks: [], fixedBlocks: [], windows: [OPEN_MONDAY] },
    });

    const monday = wrapper.findAll('[data-testid="day-column"]')[0];
    const band = monday?.find('[data-testid="open-band"]');

    expect(band?.attributes('data-start-min')).toBe('540');
    expect(band?.attributes('data-end-min')).toBe('1020');

    // And Tuesday has no window, so nothing on it is lit.
    expect(
      wrapper.findAll('[data-testid="day-column"]')[1]?.find('[data-testid="open-band"]').exists(),
    ).toBe(false);
  });

  it('draws a calendar with no windows as a wholly closed week', () => {
    // The state every calendar is in before anyone visits settings. Drawing it
    // the same as a configured week is what made an empty schedule unreadable.
    const wrapper = mount(WeekGrid, {
      props: { days: WEEK, timeZone: BERLIN, blocks: [], fixedBlocks: [] },
    });

    expect(wrapper.findAll('[data-testid="open-band"]')).toHaveLength(0);
  });

  it('keeps the shading behind the blocks, not in the tab order', () => {
    const wrapper = mount(WeekGrid, {
      props: {
        days: WEEK,
        timeZone: BERLIN,
        blocks: [block],
        fixedBlocks: [],
        windows: [OPEN_MONDAY],
      },
    });

    const band = wrapper.find('[data-testid="open-band"]');
    expect(band.attributes('aria-hidden')).toBe('true');
    expect(band.attributes('data-grid-block')).toBeUndefined();
  });

  it('never grows a vertical scrollbar of its own', () => {
    // jsdom does not lay out, so the class is the assertion. Leaving
    // `overflow-y` to compute from `overflow-x` is exactly what produced the
    // second scrollbar; saying it explicitly is what stops it coming back.
    const classes = render().find('[data-testid="week-grid"]').classes();

    expect(classes).toContain('overflow-x-auto');
    expect(classes).toContain('overflow-y-hidden');
  });
});

/**
 * What the block does between the drop and the answer (plan M12a).
 *
 * A move is a command, a re-derive and a re-read. Until the answer arrives the
 * grid's own data still has the task at its old hour — so releasing the drag
 * immediately put the block *back* for those few hundred milliseconds and then
 * jumped it forward again. The drop looked like it had been rejected and then
 * accepted, which is a worse thing to show than a moment of nothing.
 */
describe('a block that has just been dropped', () => {
  /** Editable, because a grid that cannot be dragged has nothing to settle. */
  const editable = () =>
    mount(WeekGrid, {
      props: { days: WEEK, timeZone: BERLIN, blocks: [block], fixedBlocks: [], editable: true },
    });

  /**
   * Drags the task down by `pixels` and releases.
   *
   * Native events rather than `trigger({ clientY })`: `clientY` is a getter on
   * `MouseEvent`, so test-utils cannot assign it and the drag would register as
   * a zero-pixel move — which is a click, and would have tested nothing.
   */
  async function drop(wrapper: ReturnType<typeof editable>, pixels: number): Promise<void> {
    const task = wrapper.find('[data-testid="block-task"]').element;
    const at = (type: string, clientY: number) =>
      task.dispatchEvent(new MouseEvent(type, { clientY, bubbles: true }));

    at('pointerdown', 0);
    at('pointermove', pixels);
    at('pointerup', pixels);
    await wrapper.vm.$nextTick();
  }

  it('stays where it was dropped until new blocks arrive', async () => {
    const wrapper = editable();
    await drop(wrapper, 66);

    // The command has been emitted and nothing has come back yet. The block is
    // drawn at the dropped hour, not at the one the stale data still says.
    expect(wrapper.emitted('moveBlock')).toHaveLength(1);
    expect(wrapper.find('[data-testid="block-task"]').attributes('data-start-min')).toBe('600');
  });

  it('lets go the moment the answer replaces the blocks', async () => {
    const wrapper = editable();
    await drop(wrapper, 66);

    // The server's answer — the same task, now actually at 10:00.
    await wrapper.setProps({
      blocks: [{ ...block, start: '2026-03-23T09:00:00Z', end: '2026-03-23T10:00:00Z' }],
    });

    const task = wrapper.find('[data-testid="block-task"]');
    expect(task.attributes('data-start-min')).toBe('600');
    // No longer held: the hand-off happened, so nothing is drawn by hand.
    expect(task.attributes('data-moving')).toBeUndefined();
  });

  it('does not keep responding to the pointer after the drop', async () => {
    const wrapper = editable();
    await drop(wrapper, 66);

    // A stray move — the pointer travelling on after release — must not drag
    // the block further, because the command for the first move has gone.
    wrapper
      .find('[data-testid="block-task"]')
      .element.dispatchEvent(new MouseEvent('pointermove', { clientY: 300, bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="block-task"]').attributes('data-start-min')).toBe('600');
    expect(wrapper.emitted('moveBlock')).toHaveLength(1);
  });
});

/**
 * The grid is as wide as the days it draws (spec §13).
 *
 * `grid-cols-7` was right while the week always had seven columns. Once a
 * reader could hide days, five columns filled five sevenths of the width and
 * left two sevenths blank — the calendar looked broken rather than narrower.
 */
describe('the grid track layout', () => {
  /** The element carrying the CSS grid, found by the style it sets. */
  const tracks = (wrapper: ReturnType<typeof render>): string =>
    wrapper.find('[data-testid="week-grid"] .grid').attributes('style') ?? '';

  it('gives a full week seven tracks', () => {
    expect(tracks(render())).toContain('repeat(7, minmax(0, 1fr))');
  });

  it('gives a cropped week only the tracks it draws', () => {
    const weekdaysOnly = mount(WeekGrid, {
      props: { days: WEEK.slice(0, 5), timeZone: BERLIN, blocks: [], fixedBlocks: [] },
    });

    expect(weekdaysOnly.findAll('[data-testid="day-column"]')).toHaveLength(5);
    expect(tracks(weekdaysOnly)).toContain('repeat(5, minmax(0, 1fr))');
  });

  it('shrinks the minimum width with the column count', () => {
    // Otherwise hiding the weekend leaves the grid demanding a scrollbar it no
    // longer earns — the blank space moves rather than going away.
    const single = mount(WeekGrid, {
      props: { days: WEEK.slice(0, 1), timeZone: BERLIN, blocks: [], fixedBlocks: [] },
    });

    expect(tracks(render())).toContain('52.5rem');
    expect(tracks(single)).toContain('7.5rem');
  });
});
