import { mount } from '@vue/test-utils';
import { describe, expect, it, beforeEach } from 'vitest';
import DayRangeSlider from '@/components/calendar/DayRangeSlider.vue';
import { resetWorkspace, useWorkspace } from '@/lib/workspace';

/**
 * How much of a day the grid draws (spec §13).
 *
 * A preference about looking, not about scheduling: nothing outside the range
 * is hidden from the engine and no placement changes, which is why it is held
 * in the client and never sent as a command. What it must not do is invert —
 * an end before its start would give the grid a negative height.
 */
describe('the visible day range', () => {
  beforeEach(resetWorkspace);

  it('starts on a working day rather than on midnight', () => {
    const { dayStartMin, dayEndMin } = useWorkspace();

    expect(dayStartMin.value).toBe(6 * 60);
    expect(dayEndMin.value).toBe(22 * 60);
  });

  it('shows the range it is set to', async () => {
    const { setDayRange } = useWorkspace();
    const wrapper = mount(DayRangeSlider);

    setDayRange(8 * 60, 18 * 60);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="day-range-label"]').text()).toBe('08:00–18:00');
    wrapper.unmount();
  });

  it('will not let either end cross the other', () => {
    const { dayStartMin, dayEndMin, setDayRange } = useWorkspace();

    // Dragging the start past the end keeps an hour between them rather than
    // producing a column of negative height.
    setDayRange(20 * 60, 10 * 60);
    expect(dayStartMin.value).toBeLessThan(dayEndMin.value);

    setDayRange(9 * 60, 9 * 60);
    expect(dayEndMin.value - dayStartMin.value).toBeGreaterThanOrEqual(60);
  });

  it('stays inside one day', () => {
    const { dayStartMin, dayEndMin, setDayRange } = useWorkspace();

    setDayRange(-120, 48 * 60);
    expect(dayStartMin.value).toBeGreaterThanOrEqual(0);
    expect(dayEndMin.value).toBeLessThanOrEqual(24 * 60);
  });

  it('names both handles, since neither is obvious from its position', () => {
    const wrapper = mount(DayRangeSlider);

    expect(wrapper.find('[data-testid="day-range-start"]').attributes('aria-label')).toBe(
      'First hour shown',
    );
    expect(wrapper.find('[data-testid="day-range-end"]').attributes('aria-label')).toBe(
      'Last hour shown',
    );
    wrapper.unmount();
  });
});
