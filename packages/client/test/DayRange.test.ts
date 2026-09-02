import { mount } from '@vue/test-utils';
import { describe, expect, it, beforeEach } from 'vitest';
import DayRangeSlider from '@/components/calendar/DayRangeSlider.vue';
import { readStoredRange, resetWorkspace, useWorkspace } from '@/lib/workspace';

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

/**
 * The range outlives the session (§13's boundary, deliberately not crossed).
 *
 * Stored in this browser rather than on the account: the settings that travel
 * with a user are the ones that change what the schedule *means* — zone,
 * locale, first day — because a wrong one gives a wrong answer everywhere. How
 * much of the day fits on a screen is a fact about the screen, so a laptop and
 * a phone are entitled to disagree.
 */
describe('remembering the range', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspace();
  });

  it('writes what was set', () => {
    const { setDayRange } = useWorkspace();

    setDayRange(8 * 60, 18 * 60);

    expect(JSON.parse(localStorage.getItem('ambitime.dayRange')!)).toEqual({
      startMin: 480,
      endMin: 1080,
    });
  });

  it('survives signing out, because it belongs to the browser', () => {
    const { setDayRange, dayStartMin, dayEndMin } = useWorkspace();

    setDayRange(8 * 60, 18 * 60);
    resetWorkspace();

    // `resetWorkspace` drops the schedule; re-cropping the grid as well would
    // be a small mystery with no visible cause.
    expect([dayStartMin.value, dayEndMin.value]).toEqual([480, 1080]);
  });

  it('ignores a stored value that would break the grid', () => {
    // Data from outside the application: hand-edited, or written by a version
    // that meant something else. An inverted range gives a column a negative
    // height, which is worse than an unexpected view.
    for (const bad of [
      'not json',
      '{"startMin":600,"endMin":300}',
      '{"startMin":-60,"endMin":99999}',
    ]) {
      localStorage.setItem('ambitime.dayRange', bad);
      expect(readStoredRange()).toEqual({ startMin: 6 * 60, endMin: 22 * 60 });
    }
  });
});

/**
 * A handle stays in its lane.
 *
 * Reka's `SliderRoot` sorts its pair on every move and follows the *value*
 * rather than the handle, so dragging the end past the start silently re-labels
 * them: the gesture continues as a drag of the other end, and "shrink the day
 * from the evening" becomes "move the morning to midnight". Which end was
 * grabbed is remembered for the length of the gesture, and the other is held.
 */
describe('the two ends do not trade places', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspace();
  });

  async function slider() {
    const wrapper = mount(DayRangeSlider, { attachTo: document.body });
    await wrapper.vm.$nextTick();
    return wrapper;
  }

  it('stops the end beside the start instead of pushing it', async () => {
    const { setDayRange, dayStartMin, dayEndMin } = useWorkspace();
    setDayRange(6 * 60, 22 * 60);

    const wrapper = await slider();
    // Take hold of the last-hour handle, then ask for a value below the first.
    await wrapper.find('[data-testid="day-range-end"]').trigger('pointerdown');
    (wrapper.vm as unknown as { hours: number[] }).hours = [2, 6];
    await wrapper.vm.$nextTick();

    expect(dayStartMin.value).toBe(6 * 60);
    expect(dayEndMin.value).toBe(7 * 60);
    wrapper.unmount();
  });

  it('does the same in the other direction', async () => {
    const { setDayRange, dayStartMin, dayEndMin } = useWorkspace();
    setDayRange(6 * 60, 22 * 60);

    const wrapper = await slider();
    await wrapper.find('[data-testid="day-range-start"]').trigger('pointerdown');
    (wrapper.vm as unknown as { hours: number[] }).hours = [22, 23];
    await wrapper.vm.$nextTick();

    expect(dayEndMin.value).toBe(22 * 60);
    expect(dayStartMin.value).toBe(21 * 60);
    wrapper.unmount();
  });
});
