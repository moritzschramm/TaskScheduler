import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { FixedBlock, ScheduledBlock } from '@ambitime/shared';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import { parseCivilDate, weekDays } from '@/lib/time';

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
