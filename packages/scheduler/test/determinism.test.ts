import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  byId,
  byInt,
  chain,
  compareResolvedWindows,
  descending,
  findOrderingTies,
  resolveWindows,
  sorted,
  validateSchedule,
  type Placement,
  type Schedulable,
  type ScheduleContext,
} from '../src/index.js';
import { at, context, fixedBlock, schedulable, sequence } from './support/fixtures.js';

/**
 * Determinism is a hard requirement (spec §6.3): the client computes an
 * optimistic schedule and the server the authoritative one, and they must
 * agree. The properties here are the ones that make that possible — no result
 * may depend on the order rows arrived in, and every tie-break must be total.
 */

/** Generates a small schedule: some schedulables and a placement for each. */
const scheduleArbitrary = fc
  .array(
    fc.record({
      index: fc.integer({ min: 0, max: 40 }),
      startOffset: fc.integer({ min: 0, max: 400 }),
      durationMin: fc.integer({ min: 15, max: 120 }),
      cooldownMin: fc.constantFrom(0, 15, 30),
      hasDueDate: fc.boolean(),
      hasFloor: fc.boolean(),
      inSequence: fc.boolean(),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((specs) => {
    const windowStart = at('2026-03-23T08:00:00Z');
    const schedulables: Schedulable[] = [];
    const placements: Placement[] = [];

    specs.forEach((spec, i) => {
      const occurrenceId = `occ-${i}`;
      const start = windowStart + spec.startOffset;

      schedulables.push(
        schedulable({
          occurrenceId,
          durationMin: spec.durationMin,
          cooldownMin: spec.cooldownMin,
          ...(spec.hasDueDate ? { dueDate: windowStart + 300, dueKind: 'hard' as const } : {}),
          ...(spec.hasFloor ? { manualFloor: windowStart + 60 } : {}),
          ...(spec.inSequence ? { sequenceId: 'seq', sequencePosition: i + 1 } : {}),
        }),
      );

      placements.push({
        occurrenceId,
        interval: { start, end: start + spec.durationMin },
        cooldownMin: spec.cooldownMin,
      });
    });

    return { schedulables, placements };
  });

describe('validation is order-insensitive', () => {
  it('reports the same violations however the placements are ordered', () => {
    // Spec §3.3 has the server validate a schedule the client proposed; the two
    // sides have no reason to agree on array order, so the verdict must not
    // depend on it.
    fc.assert(
      fc.property(
        scheduleArbitrary,
        fc.array(fc.integer()),
        ({ schedulables, placements }, seed) => {
          const ctx = context({ schedulables, sequences: [sequence('seq', true)] });

          const inOrder = validateSchedule(ctx, placements);
          const shuffled = validateSchedule(ctx, permute(placements, seed));

          expect(shuffled).toEqual(inOrder);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reports the same violations however the schedulables are ordered', () => {
    fc.assert(
      fc.property(
        scheduleArbitrary,
        fc.array(fc.integer()),
        ({ schedulables, placements }, seed) => {
          const baseline = validateSchedule(
            context({ schedulables, sequences: [sequence('seq', true)] }),
            placements,
          );
          const reordered = validateSchedule(
            context({
              schedulables: permute(schedulables, seed),
              sequences: [sequence('seq', true)],
            }),
            placements,
          );

          expect(reordered).toEqual(baseline);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reports the same violations however the fixed blocks are ordered', () => {
    const blocks = [
      fixedBlock('b1', '2026-03-23T09:00:00Z', '2026-03-23T09:30:00Z'),
      fixedBlock('b2', '2026-03-23T10:00:00Z', '2026-03-23T10:30:00Z'),
      fixedBlock('b3', '2026-03-23T11:00:00Z', '2026-03-23T11:30:00Z'),
    ];
    const a = schedulable({ occurrenceId: 'a', durationMin: 180 });
    const placements: Placement[] = [
      {
        occurrenceId: 'a',
        interval: { start: at('2026-03-23T09:00:00Z'), end: at('2026-03-23T12:00:00Z') },
        cooldownMin: 0,
      },
    ];

    const forwards = validateSchedule(
      context({ schedulables: [a], fixedBlocks: blocks }),
      placements,
    );
    const backwards = validateSchedule(
      context({ schedulables: [a], fixedBlocks: [...blocks].reverse() }),
      placements,
    );

    expect(backwards).toEqual(forwards);
  });

  it('is idempotent — validating twice gives the identical result', () => {
    fc.assert(
      fc.property(scheduleArbitrary, ({ schedulables, placements }) => {
        const ctx = context({ schedulables, sequences: [sequence('seq', true)] });
        expect(validateSchedule(ctx, placements)).toEqual(validateSchedule(ctx, placements));
      }),
      { numRuns: 200 },
    );
  });

  it('does not mutate its inputs', () => {
    // A caller passing the same arrays to two solves must get the same answer
    // twice; an in-place sort would silently break that.
    const schedulables = [schedulable({ occurrenceId: 'z' }), schedulable({ occurrenceId: 'a' })];
    const placements = [
      {
        occurrenceId: 'z',
        interval: { start: at('2026-03-23T12:00:00Z'), end: at('2026-03-23T13:00:00Z') },
        cooldownMin: 0,
      },
      {
        occurrenceId: 'a',
        interval: { start: at('2026-03-23T09:00:00Z'), end: at('2026-03-23T10:00:00Z') },
        cooldownMin: 0,
      },
    ];
    const ctx: ScheduleContext = context({ schedulables });

    const snapshot = JSON.stringify({ ctx, placements });
    validateSchedule(ctx, placements);

    expect(JSON.stringify({ ctx, placements })).toBe(snapshot);
  });
});

describe('ordering utilities', () => {
  it('breaks every tie, so no two distinct items compare equal', () => {
    // A comparator that ties is the exact failure mode that makes client and
    // server diverge: both sort correctly, both pick a different valid order.
    const items = [
      { start: 100, id: 'b' },
      { start: 100, id: 'a' },
      { start: 50, id: 'c' },
    ];
    const total = chain(
      byInt<{ start: number; id: string }>((i) => i.start),
      byId((i) => i.id),
    );

    expect(findOrderingTies(items, total)).toEqual([]);
    expect(sorted(items, total).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('detects a comparator that leaves ties', () => {
    const items = [
      { start: 100, id: 'b' },
      { start: 100, id: 'a' },
    ];
    const partial = byInt<{ start: number; id: string }>((i) => i.start);

    expect(findOrderingTies(items, partial)).toHaveLength(1);
  });

  it('sorts a copy rather than in place', () => {
    const items = [{ v: 3 }, { v: 1 }, { v: 2 }];
    const original = [...items];

    sorted(
      items,
      byInt((i) => i.v),
    );

    expect(items).toEqual(original);
  });

  it('produces one stable order regardless of input order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            start: fc.integer({ min: 0, max: 20 }),
            id: fc.string({ minLength: 1, maxLength: 4 }),
          }),
          {
            minLength: 1,
            maxLength: 20,
          },
        ),
        fc.array(fc.integer()),
        (items, seed) => {
          const unique = dedupeById(items);
          const total = chain(
            byInt<{ start: number; id: string }>((i) => i.start),
            byId((i) => i.id),
          );

          expect(sorted(permute(unique, seed), total)).toEqual(sorted(unique, total));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reverses cleanly for descending orders', () => {
    const items = [{ v: 1 }, { v: 3 }, { v: 2 }];
    expect(sorted(items, descending(byInt((i) => i.v))).map((i) => i.v)).toEqual([3, 2, 1]);
  });
});

describe('window resolution is deterministic', () => {
  const rules = [
    {
      id: 'r-mon',
      calendarId: 'cal-1',
      activityTypeId: 'cat-work',
      weekday: 1,
      startMin: 540,
      endMin: 720,
    },
    {
      id: 'r-tue',
      calendarId: 'cal-1',
      activityTypeId: 'cat-work',
      weekday: 2,
      startMin: 540,
      endMin: 720,
    },
    {
      id: 'r-wed',
      calendarId: 'cal-1',
      activityTypeId: 'cat-work',
      weekday: 3,
      startMin: 600,
      endMin: 780,
    },
  ];
  const input = {
    horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-28T00:00:00Z') },
    calendars: [{ id: 'cal-1', timeZone: 'Europe/Berlin' }],
  };

  it('produces the same windows however the rules are ordered', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (seed) => {
        expect(resolveWindows({ ...input, rules: permute(rules, seed) })).toEqual(
          resolveWindows({ ...input, rules }),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('returns windows in a total order with no ties', () => {
    const windows = resolveWindows({ ...input, rules });

    expect(windows.length).toBeGreaterThan(0);
    expect(findOrderingTies(windows, compareResolvedWindows)).toEqual([]);
  });
});

/** A deterministic permutation driven by the generated seed. */
function permute<T>(items: readonly T[], seed: readonly number[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const pick = seed.length === 0 ? i : Math.abs(seed[i % seed.length] ?? 0) % (i + 1);
    const swap = result[i]!;
    result[i] = result[pick]!;
    result[pick] = swap;
  }
  return result;
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}
