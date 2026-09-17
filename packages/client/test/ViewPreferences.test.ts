import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SCALE, MAX_SCALE, MIN_SCALE, currentScale } from '@/lib/grid';
import { formatCivilDate, parseCivilDate } from '@/lib/time';
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

  describe('the days on screen', () => {
    // The crop outlives `resetWorkspace` on purpose — it belongs to the screen,
    // not the account — so each of these says which days it is starting from.
    beforeEach(() => useWorkspace().setVisibleWeekdays([1, 2, 3, 4, 5, 6, 7]));

    it('is the week, when a week is what is drawn', () => {
      const { setMode, showWeekOf, drawnDays } = useWorkspace();
      showWeekOf(parseCivilDate('2026-03-25'));
      setMode('week');

      expect(drawnDays.value.map(formatCivilDate)).toEqual([
        '2026-03-23',
        '2026-03-24',
        '2026-03-25',
        '2026-03-26',
        '2026-03-27',
        '2026-03-28',
        '2026-03-29',
      ]);
    });

    it('loses a weekday that has been hidden', () => {
      const { setMode, setVisibleWeekdays, showWeekOf, drawnDays } = useWorkspace();
      showWeekOf(parseCivilDate('2026-03-25'));
      setMode('week');
      setVisibleWeekdays([1, 2, 3, 4, 5]);

      // Which is why "elsewhere" asks the set rather than comparing against its
      // two ends: a Wednesday hidden on its own is not between Monday and
      // Friday as far as a reader is concerned.
      expect(drawnDays.value.map(formatCivilDate)).not.toContain('2026-03-28');
    });

    it('is whole weeks, either side of the month, when a month is drawn', () => {
      // **The fix for a footnote that argued with the grid above it.** Measured
      // against the week, a month view showing four tasks on the 21st reported
      // all four as scheduled somewhere else — while pointing at the cells they
      // were in. March 2026 starts on a Sunday, so the grid opens on the 23rd
      // of February and runs to the 5th of April, and everything drawn on those
      // days is on screen.
      const { setMode, showWeekOf, drawnDays } = useWorkspace();
      showWeekOf(parseCivilDate('2026-03-25'));
      setMode('month');

      const drawn = drawnDays.value.map(formatCivilDate);
      expect(drawn).toHaveLength(6 * 7);
      expect(drawn[0]).toBe('2026-02-23');
      expect(drawn.at(-1)).toBe('2026-04-05');
      expect(drawn).toContain('2026-03-01');
      expect(drawn).toContain('2026-03-31');
    });

    it('draws the whole month even with a weekday hidden', () => {
      // The month grid has seven columns whatever the week view is cropped to;
      // a notice that trusted the crop would claim a hidden Saturday's work was
      // off screen while the cell for it is right there.
      const { setMode, setVisibleWeekdays, showWeekOf, drawnDays } = useWorkspace();
      showWeekOf(parseCivilDate('2026-03-25'));
      setVisibleWeekdays([1, 2, 3, 4, 5]);
      setMode('month');

      expect(drawnDays.value).toHaveLength(6 * 7);
    });
  });

  describe('with the tasks hidden', () => {
    it('is on by default, so the week shows what was scheduled', () => {
      expect(useWorkspace().showTasks.value).toBe(true);
    });

    it('turns an empty hour into a fixed block rather than a task', () => {
      const { setShowTasks, newAtSlot, editing } = useWorkspace();
      const friday = { year: 2026, month: 3, day: 27 };

      newAtSlot(friday, 9 * 60);
      expect(editing.value.kind).toBe('task');

      // Hidden, the grid is showing only the time already spoken for — so
      // clicking an empty stretch of it means the other obvious thing. This is
      // what the Appointments page's own grid did, before it was a checkbox.
      setShowTasks(false);
      newAtSlot(friday, 9 * 60);
      expect(editing.value.kind).toBe('block');
    });

    it('remembers the answer in this browser', () => {
      useWorkspace().setShowTasks(false);
      expect(globalThis.localStorage?.getItem('ambitime.showTasks')).toBe('false');
    });
  });
});
