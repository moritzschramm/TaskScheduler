import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_INK,
  CATEGORY_BLOCK_INK,
  CATEGORY_BLOCK_STEPS,
  CATEGORY_COLORS,
} from '@ambitime/shared';
import type {
  CalendarConfiguration,
  CompletedBlock,
  FixedBlock,
  ScheduledBlock,
} from '@ambitime/shared';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import { parseCivilDate, weekDays } from '@/lib/time';
import type { ResolvedWindow } from '@ambitime/scheduler';

/**
 * A placed block wears its activity type's colour (spec §4.3).
 *
 * The week used to fill every task with one near-black, which said "this is
 * settled" and nothing else — while the lanes underneath it had eight colours
 * between them. So the two things a column shows, *what kind of time this is*
 * and *what is actually happening in it*, were drawn in two unrelated
 * vocabularies, and the second one was mute.
 *
 * What is under test is the pairing rather than the pigment: a block takes the
 * **block** step, its lane keeps the **lane** step, and the two are never the
 * same value — that separation is the whole reason a fill can sit on a wash
 * without dissolving into it.
 */

const BERLIN = 'Europe/Berlin';
const WEEK = weekDays(parseCivilDate('2026-03-23'), 1);

const categories = [
  { id: 'cat-work', name: 'Work', defaultCooldownMin: 0, color: 'blue', version: 1 },
  { id: 'cat-gym', name: 'Exercise', defaultCooldownMin: 0, color: 'orange', version: 1 },
  { id: 'cat-old', name: 'Legacy', defaultCooldownMin: 0, color: null, version: 1 },
] as CalendarConfiguration['categories'];

const report: ScheduledBlock = {
  occurrenceId: 'occ-1',
  taskId: 'task-1',
  title: 'Write the report',
  categoryId: 'cat-work',
  start: '2026-03-23T08:00:00.000Z',
  end: '2026-03-23T09:00:00.000Z',
  cooldownMin: 0,
};

const standup: FixedBlock = {
  appointmentId: 'appt-1',
  title: 'Standup',
  notes: null,
  start: '2026-03-23T10:00:00.000Z',
  end: '2026-03-23T10:30:00.000Z',
  version: 1,
  occurrenceStart: null,
  isRecurring: false,
  isUnavailability: false,
  cooldownMin: 0,
  isInternal: true,
  status: 'confirmed',
};

const stretched: CompletedBlock = {
  occurrenceId: 'occ-2',
  taskId: 'task-2',
  title: 'Stretch',
  categoryId: 'cat-gym',
  start: '2026-03-23T06:00:00.000Z',
  end: '2026-03-23T06:30:00.000Z',
  completedAt: '2026-03-23T06:30:00.000Z',
};

/** One Berlin 09:00–17:00 window, so a lane is drawn under the blocks. */
const windows: ResolvedWindow[] = [
  {
    ruleId: 'w-1',
    calendarId: 'cal',
    categoryId: 'cat-work',
    interval: { start: Date.UTC(2026, 2, 23, 8) / 60_000, end: Date.UTC(2026, 2, 23, 16) / 60_000 },
  },
];

function week(
  blocks: ScheduledBlock[] = [report],
  fixedBlocks: FixedBlock[] = [],
  completedBlocks: CompletedBlock[] = [],
) {
  return mount(WeekGrid, {
    props: {
      days: WEEK,
      timeZone: BERLIN,
      blocks,
      fixedBlocks,
      completedBlocks,
      categories,
      windows,
    },
  });
}

/** The inline style on the first block of a kind, as written. */
function styleOf(wrapper: ReturnType<typeof week>, kind: string): string {
  return wrapper.find(`[data-testid="block-${kind}"]`).attributes('style') ?? '';
}

describe('a task on the week grid', () => {
  it('is filled with its own activity type, not with the application ink', () => {
    const style = styleOf(week(), 'task');

    expect(style).toContain('--category-block-blue');
    expect(style).toContain('var(--category-ink-blue)');
  });

  it('draws two types in two colours', () => {
    const gym = {
      ...report,
      occurrenceId: 'occ-3',
      title: 'Squats',
      categoryId: 'cat-gym',
      start: '2026-03-23T16:00:00.000Z',
      end: '2026-03-23T17:00:00.000Z',
    };

    const styles = week([report, gym])
      .findAll('[data-testid="block-task"]')
      .map((block) => block.attributes('style') ?? '');

    // In clock order, which is the order the grid builds a day in.
    expect(styles[0]).toContain('--category-block-blue');
    expect(styles[1]).toContain('--category-block-orange');
  });

  it('keeps the old neutral fill for a type that has no colour', () => {
    // A type made before migration 0018, or one an undo put back that way.
    // Three of these on a grid would be three greys; one is the honest answer.
    const wrapper = week([{ ...report, categoryId: 'cat-old' }]);
    const block = wrapper.find('[data-testid="block-task"]');

    expect(block.attributes('style')).not.toContain('--category-block');
    expect(block.classes()).toContain('bg-primary');
  });

  it('leaves a fixed block alone, because a meeting has no activity type', () => {
    const wrapper = week([], [standup]);
    const block = wrapper.find('[data-testid="block-appointment"]');

    expect(block.attributes('style')).not.toContain('--category-block');
    expect(block.classes()).toContain('bg-secondary');
  });

  it('tints a finished one rather than filling it, and keeps it dashed', () => {
    const style = styleOf(week([], [], [stretched]), 'completed');

    // Done is carried by the strike-through and the dashed edge; the hue is
    // there to say which kind of work it was, not to compete with the week
    // still ahead.
    expect(style).toContain('color-mix');
    expect(style).toContain('--category-block-orange');
    expect(styleOf(week([], [], [stretched]), 'completed')).not.toContain('--category-ink');
  });

  it('does not fade the time under the title, which no hue can carry', () => {
    // It was the block's ink at 70%, which is fine on one near-black and a
    // contrast failure on eight hues: the steps clear 5:1 at full strength, so
    // the best any fade can manage is 4.35 at 90%. Weight says the same thing.
    const line = week().find('[data-testid="block-task"] p.tabular-nums');

    expect(line.classes()).not.toContain('opacity-70');
    expect(line.classes()).toContain('font-normal');
  });

  it('writes the lane label in an ink that passes on the wash', () => {
    // `--muted-foreground` measured 3.04:1 on a lane in today's column and
    // 4.00:1 on the dark surface. jsdom cannot compute that, so what is pinned
    // here is the token; the value behind it is derived in `main.css`.
    const label = week().find('[data-testid="category-lane"] span');

    expect(label.exists()).toBe(true);
    expect(label.classes()).toContain('text-(--ink-subtle)');
    expect(label.classes()).not.toContain('text-muted-foreground');
  });

  it('hands the done strip the same ink the block is written in', () => {
    // The strip is a sibling — a button inside a button is invalid — so it
    // cannot inherit, and it used to assume the neutral foreground. On a blue
    // block that put a white-on-blue tick's worth of contrast nowhere near
    // where it was calculated.
    const wrapper = mount(WeekGrid, {
      props: {
        days: WEEK,
        timeZone: BERLIN,
        blocks: [report],
        fixedBlocks: [],
        categories,
        windows,
        editable: true,
      },
    });

    expect(wrapper.find('[data-testid="complete-block"]').attributes('style')).toContain(
      '--block-ink: var(--category-ink-blue)',
    );
  });
});

describe('the month view', () => {
  function month(blocks: ScheduledBlock[] = [report]) {
    return mount(MonthGrid, {
      props: {
        month: parseCivilDate('2026-03-01'),
        timeZone: BERLIN,
        firstDayOfWeek: 1,
        blocks,
        categories,
      },
    });
  }

  it('says which kind of work a day holds', () => {
    expect(month().find('[data-testid="month-block-task"]').attributes('data-color')).toBe('blue');
  });

  it('tints rather than fills, so forty-two cells stay readable', () => {
    const style = month().find('[data-testid="month-block-task"]').attributes('style') ?? '';

    expect(style).toContain('color-mix');
    // The ink stays the page's own: 0.7rem of text never sits on a colour here,
    // so the only property set is the background.
    expect(style).not.toMatch(/(^|;)\s*color:/);
  });
});

/** WCAG 2.x relative luminance, which is all a contrast ratio needs. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe('the two steps of a slot', () => {
  it('gives every colour a block step as well as a lane step', () => {
    // Or a block would fall back to the neutral fill for exactly the types
    // somebody had bothered to colour.
    expect(Object.keys(CATEGORY_BLOCK_STEPS).sort()).toEqual([...CATEGORY_COLORS].sort());
  });

  it('carries 12px text on every one of them, in both modes', () => {
    // WCAG 1.4.3: a block says a title and a time in `text-xs`, which is small
    // text, which is 4.5:1 — and the *lane* steps do not clear it, which is the
    // reason the block column exists. Derived at 5:1 for headroom, asserted at
    // the standard so a deliberate re-step is a decision, not a failing test.
    for (const color of CATEGORY_COLORS) {
      const step = CATEGORY_BLOCK_STEPS[color];
      const ink = CATEGORY_BLOCK_INK[color];
      expect(contrast(step.light, ink.light), `${color} light`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(step.dark, ink.dark), `${color} dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('stands clear of the column it is drawn on', () => {
    // WCAG 1.4.11, and the rule the first derivation forgot. A fill can pass
    // the text rule and still melt into the day body behind it — which is what
    // green did, because one value served both columns of the lane palette and
    // as a *fill* that is a dark green box on a dark grey page.
    const DAY_BODY = { light: '#f1f5f9', dark: '#1d293d' };

    for (const color of CATEGORY_COLORS) {
      const step = CATEGORY_BLOCK_STEPS[color];
      expect(contrast(step.light, DAY_BODY.light), `${color} light`).toBeGreaterThanOrEqual(3);
      expect(contrast(step.dark, DAY_BODY.dark), `${color} dark`).toBeGreaterThanOrEqual(3);
    }
  });

  it('writes every dark-surface block in the dark ink', () => {
    // Not a rule of its own — a consequence of the two above. On a dark page a
    // block must be lighter than the page, and nothing light enough for that
    // carries white text.
    for (const color of CATEGORY_COLORS) {
      expect(CATEGORY_BLOCK_INK[color].dark, color).toBe(BLOCK_INK.dark);
    }
  });

  it('keeps yellow yellow, which is why the ink is allowed to vary', () => {
    // The whole argument for a per-slot ink, in one assertion. Forced onto
    // white text, yellow has to darken to #976500 — the same hue angle, and
    // brown to anybody naming it, which is not a colour you connect to a pale
    // yellow lane. With the dark ink it barely moves.
    expect(CATEGORY_BLOCK_INK.yellow.light).toBe(BLOCK_INK.dark);
    expect(luminance(CATEGORY_BLOCK_STEPS.yellow.light)).toBeGreaterThan(luminance('#976500'));
  });
});
