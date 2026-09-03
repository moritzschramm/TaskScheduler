import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DisplaySection from '@/components/settings/DisplaySection.vue';
import { AUTOSAVE_DELAY_MS } from '@/lib/autosave';
import { formatDayLabel, formatMinuteOfDay, weekdayNames } from '@/lib/time';
import { parseCivilDate } from '@/lib/time';
import type { CommandRequest } from '@ambitime/shared';

/**
 * Spec §13: "Date/time formatting, first-day-of-week, locale, and timezone are
 * user settings."
 *
 * What matters is that a *setting* reaches the formatting, and that unset stays
 * unset. A default written into the database would be a decision made on
 * somebody's behalf, which they then have to notice and undo.
 */
describe('display settings', () => {
  function section() {
    // Installed before the component exists, so the debounce's `setTimeout` is
    // the fake one. Installing it afterwards leaves a real timer running that
    // no amount of advancing the clock will reach — which is exactly the shape
    // of test that passes by never asserting anything.
    vi.useFakeTimers();
    const submit = vi.fn<(request: CommandRequest) => Promise<boolean>>().mockResolvedValue(true);
    const wrapper = mount(DisplaySection, {
      props: { calendarTimeZone: 'Europe/Berlin', submit },
    });
    return { wrapper, submit };
  }

  /**
   * Lets the debounce elapse.
   *
   * There is no Save button any more, so what a test has to wait for is the
   * quiet period rather than a click. Fake timers rather than a real delay:
   * Vue's own scheduler runs on microtasks, so nothing else here is affected.
   * `advanceTimersByTimeAsync` drains those between ticks, which is what lets
   * the awaited `submit` inside the debounced action actually run.
   */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers "follow the calendar" as a real choice, not an empty box', () => {
    const { wrapper } = section();

    // Unset is a meaningful state: it means "you decide", and a user who has
    // never opened this screen is in it.
    expect(wrapper.find('[data-testid="settings-timezone"]').text()).toContain('Europe/Berlin');
    expect(wrapper.find('[data-testid="settings-locale"]').text()).toContain("Use my browser's");
  });

  it('sends null to clear a setting rather than omitting it', async () => {
    const { wrapper, submit } = section();

    await wrapper.find('[data-testid="settings-locale"]').setValue('de-DE');
    await settle();
    await wrapper.find('[data-testid="settings-locale"]').setValue('');
    await settle();

    // Omitting would mean "leave it alone"; `null` means "put me back to
    // following whatever I am looking at" (§13).
    expect(submit.mock.calls.at(-1)?.[0]).toEqual({
      type: 'UpdateSettings',
      params: { patch: { locale: null, timeZone: null, firstDayOfWeek: null } },
    });
  });

  it('sends what was chosen, without being asked to save', async () => {
    const { wrapper, submit } = section();

    await wrapper.find('[data-testid="settings-locale"]').setValue('de-DE');
    await wrapper.find('[data-testid="settings-timezone"]').setValue('Europe/Lisbon');
    await wrapper.find('[data-testid="settings-first-day"]').setValue('7');
    await settle();

    expect(submit.mock.calls.at(-1)?.[0]).toMatchObject({
      params: { patch: { locale: 'de-DE', timeZone: 'Europe/Lisbon', firstDayOfWeek: 7 } },
    });
  });

  /**
   * Three changes in a row are one intent, not three.
   *
   * Without the debounce each keystroke would be its own command: three rows in
   * the audit log (§12) and three re-derives, for one visit to this screen.
   */
  it('coalesces a burst of changes into one command', async () => {
    const { wrapper, submit } = section();

    await wrapper.find('[data-testid="settings-locale"]').setValue('de-DE');
    await wrapper.find('[data-testid="settings-timezone"]').setValue('Europe/Lisbon');
    await wrapper.find('[data-testid="settings-first-day"]').setValue('7');
    await settle();

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('previews the effect before it is saved', async () => {
    const { wrapper } = section();

    // 13:05 UTC on 2026-03-29 — the day the clocks go forward in Europe, so
    // Berlin is already CEST and Lisbon is not yet WEST.
    await wrapper.find('[data-testid="settings-timezone"]').setValue('Europe/Lisbon');
    const lisbon = wrapper.find('[data-testid="settings-preview"]').text();

    await wrapper.find('[data-testid="settings-timezone"]').setValue('Asia/Tokyo');
    const tokyo = wrapper.find('[data-testid="settings-preview"]').text();

    // Formatting settings are the kind whose effect is obvious once seen and
    // impossible to predict from a dropdown.
    expect(lisbon).not.toBe(tokyo);
  });

  it('previews the locale, not only the zone', async () => {
    const { wrapper } = section();

    await wrapper.find('[data-testid="settings-locale"]').setValue('en-GB');
    const british = wrapper.find('[data-testid="settings-preview"]').text();

    await wrapper.find('[data-testid="settings-locale"]').setValue('de-DE');
    const german = wrapper.find('[data-testid="settings-preview"]').text();

    expect(british).not.toBe(german);
    expect(german).toContain('Sonntag');
  });
});

/**
 * The formatting helpers themselves, across locales (§13).
 *
 * Deliberately not snapshots of exact strings: `Intl` output varies with the
 * ICU data a runtime ships, and a test asserting "29 March 2026" would fail on
 * a Node upgrade for no reason worth anyone's time. What is asserted is that
 * the locale is *used* — the property the settings exist to deliver.
 */
describe('formatting follows the locale', () => {
  const day = parseCivilDate('2026-03-29');

  it('names the same day differently in different languages', () => {
    expect(formatDayLabel(day, 'en-GB')).not.toBe(formatDayLabel(day, 'de-DE'));
    expect(formatDayLabel(day, 'de-DE')).toMatch(/So|Sonntag/);
  });

  it('names weekdays in ISO order whatever the language', () => {
    // 1 = Monday … 7 = Sunday, matching Postgres `extract(isodow)` — the order
    // the whole system counts weekdays in (§4.3).
    expect(weekdayNames('en-GB')[0]).toBe('Monday');
    expect(weekdayNames('de-DE')[0]).toBe('Montag');
    expect(weekdayNames('en-GB')[6]).toBe('Sunday');
  });

  it('keeps the grid axis in 24-hour minutes regardless of locale', () => {
    // The axis is arithmetic, not prose: it labels a position in the day, and
    // a 12-hour clock would make two rows read the same.
    expect(formatMinuteOfDay(13 * 60 + 5)).toBe('13:05');
    expect(formatMinuteOfDay(0)).toBe('00:00');
  });
});
