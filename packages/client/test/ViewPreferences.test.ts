import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SCALE, MAX_SCALE, MIN_SCALE, currentScale } from '@/lib/grid';
import { readStoredWeekdays, resetWorkspace, useWorkspace } from '@/lib/workspace';

/**
 * The preferences that crop the calendar rather than change it (spec §13).
 *
 * All three — the day range, the row height, the days shown — answer "make this
 * fit on my screen", not "schedule differently". None of them is a command,
 * none reaches the engine, and each is stored in this browser. What they do
 * have to get right is the boundary: a crop that produced an empty grid, or a
 * row height that disagreed with the drag arithmetic, would be a broken screen
 * rather than a narrower one.
 */
describe('view preferences', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    resetWorkspace();
  });

  it('shows every weekday until told otherwise', () => {
    expect(readStoredWeekdays()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps the chosen days, in ISO order however they were given', () => {
    const { setVisibleWeekdays, visibleWeekdays } = useWorkspace();

    setVisibleWeekdays([5, 1, 3]);

    // Order is the grid's, not the click order: a Monday must not appear after
    // a Friday because it was ticked second.
    expect(visibleWeekdays.value).toEqual([1, 3, 5]);
    expect(readStoredWeekdays()).toEqual([1, 3, 5]);
  });

  it('refuses to hide the last day', () => {
    const { setVisibleWeekdays, visibleWeekdays } = useWorkspace();
    setVisibleWeekdays([3]);

    setVisibleWeekdays([]);

    // A grid with no columns is not a smaller calendar, it is a broken one.
    expect(visibleWeekdays.value).toEqual([3]);
  });

  it('ignores a stored value that is not a set of weekdays', () => {
    // Data from outside: hand-edited, or left by an older version.
    globalThis.localStorage?.setItem('ambitime.weekdays', '"every day"');
    expect(readStoredWeekdays()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    globalThis.localStorage?.setItem('ambitime.weekdays', '[0, 9, 42]');
    expect(readStoredWeekdays()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('clamps the row height, and tells the drag arithmetic', () => {
    const { setRowScale, rowScale } = useWorkspace();

    setRowScale(99);
    expect(rowScale.value).toBe(MAX_SCALE);
    // The same number the drop calculation reads — two copies could disagree,
    // and a drop landing on a different hour is what that would look like.
    expect(currentScale()).toBe(MAX_SCALE);

    setRowScale(0);
    expect(rowScale.value).toBe(MIN_SCALE);
    expect(currentScale()).toBe(MIN_SCALE);

    setRowScale(DEFAULT_SCALE);
  });

  it('survives a sign-out, because it belongs to the screen and not the account', () => {
    const { setVisibleWeekdays } = useWorkspace();
    setVisibleWeekdays([1, 2, 3, 4, 5]);

    resetWorkspace();

    expect(readStoredWeekdays()).toEqual([1, 2, 3, 4, 5]);
  });
});
