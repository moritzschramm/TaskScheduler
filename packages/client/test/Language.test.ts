import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { de } from '@/i18n/de';
import { en } from '@/i18n/en';
import { languageOf, translate } from '@/i18n';

/**
 * The interface in two languages (spec §13).
 *
 * Three things are worth pinning, and only one of them is caught by the
 * compiler. The type makes a *missing* German key impossible; it says nothing
 * about an extra one, nothing about which language a given locale selects, and
 * nothing about what happens when a key is asked for that neither catalogue
 * has.
 */
describe('language selection', () => {
  it('follows the primary subtag, not the region', () => {
    // A region decides how a date is written, not which words are used, so
    // every German-speaking region gets the German interface.
    expect(languageOf('de')).toBe('de');
    expect(languageOf('de-DE')).toBe('de');
    expect(languageOf('de-AT')).toBe('de');
    expect(languageOf('de-CH')).toBe('de');
    expect(languageOf('DE-de')).toBe('de');
  });

  it('falls back to English for anything else', () => {
    // Not a claim that French is unsupported — a claim that it is not
    // translated, and that half a French interface is worse than none.
    expect(languageOf('en-GB')).toBe('en');
    expect(languageOf('fr-FR')).toBe('en');
    expect(languageOf('ja-JP')).toBe('en');
    expect(languageOf('')).toBe('en');
  });
});

describe('the catalogues', () => {
  /** Every dotted leaf path, so two trees can be compared as flat key sets. */
  function paths(node: unknown, prefix = ''): string[] {
    if (typeof node === 'string') return [prefix];
    if (typeof node !== 'object' || node === null) return [];
    return Object.entries(node).flatMap(([key, value]) =>
      paths(value, prefix === '' ? key : `${prefix}.${key}`),
    );
  }

  it('hold exactly the same keys', () => {
    // The type already forbids a missing German key. It permits an extra one —
    // a leftover from a renamed message, which nothing renders and nobody
    // notices until it is the only translation of something.
    expect(paths(de).sort()).toEqual(paths(en).sort());
  });

  it('leaves nothing in English by accident', () => {
    // A German catalogue entry identical to the English one is either a word
    // that is genuinely the same — a proper noun, an abbreviation — or a
    // translation somebody forgot. The first kind is short; the second is not.
    const shared = paths(en).filter((key) => {
      const source = translate('en', key as never);
      return source === translate('de', key as never) && source.length > 12;
    });

    expect(shared).toEqual([]);
  });
});

describe('translating', () => {
  it('substitutes named parameters', () => {
    expect(translate('en', 'calendar.more', { count: 3 })).toBe('+3 more');
    expect(translate('de', 'calendar.more', { count: 3 })).toBe('+3 weitere');
  });

  it('leaves a placeholder alone when nothing was given for it', () => {
    // Better a visible `{zone}` than an empty gap: one is obviously a bug and
    // the other reads as a sentence that simply stops.
    expect(translate('en', 'calendar.plannerZone', {})).toBe('(planner is {zone})');
  });

  it('returns the key when there is no such message', () => {
    // Never an empty string. A button with no label is an invisible failure;
    // a key is ugly, obvious and greppable.
    expect(translate('de', 'nope.not.here' as never)).toBe('nope.not.here');
  });

  it('falls back to English rather than showing a key', () => {
    // If a German entry were ever absent at runtime — a hand-edited bundle, a
    // catalogue loaded from elsewhere later — the English word is a better
    // answer than `tasks.title`.
    const catalogue = de as unknown as Record<string, Record<string, string>>;
    const original = catalogue['tasks']!['title'];
    delete catalogue['tasks']!['title'];

    try {
      expect(translate('de', 'tasks.title')).toBe('Tasks');
    } finally {
      catalogue['tasks']!['title'] = original!;
    }
  });
});

describe('a German interface', () => {
  it('renders German words, not English ones', async () => {
    vi.resetModules();
    vi.doMock('@/lib/session', () => ({
      displayLocale: () => 'de-DE',
      session: { value: null },
      displayTimeZone: (fallback: string) => fallback,
      displayFirstDayOfWeek: () => 1,
    }));

    const { default: BacklogPanel } = await import('@/components/panels/BacklogPanel.vue');
    const wrapper = mount(BacklogPanel, { props: { entries: [] } });

    expect(wrapper.text()).toContain('Rückstand');
    expect(wrapper.text()).toContain('Alles passt in den Planungszeitraum.');
    expect(wrapper.text()).not.toContain('Backlog');

    vi.doUnmock('@/lib/session');
    vi.resetModules();
  });
});
