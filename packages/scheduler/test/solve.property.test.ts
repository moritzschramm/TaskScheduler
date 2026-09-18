import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  solve,
  validateSchedule,
  withTuning,
  type FixedBlock,
  type Placement,
  type Schedulable,
  type ScheduleContext,
  type SequenceSpec,
} from '../src/index.js';
import { at, context, MONDAY_WINDOW, TUESDAY_WINDOW } from './support/fixtures.js';

/**
 * The property suite for the engine (spec §14), extended in M5 with sequences.
 *
 * The headline property is the first one: **whatever the solver returns must
 * pass the M3 validator**. That single assertion covers every hard constraint
 * at once — no overlap, inside a window, cooldown respected, no hard due date
 * missed — over randomised inputs rather than hand-picked ones, and it is the
 * precise statement of "soft constraints never override hard ones".
 *
 * Sequences get their own scenario generator further down: they constrain a
 * group rather than a single placement, so they deserve properties stated in
 * terms of the group.
 */

const WINDOW_START = MONDAY_WINDOW.interval.start;

const schedulableArbitrary = fc
  .record({
    index: fc.integer({ min: 0, max: 99 }),
    durationMin: fc.integer({ min: 15, max: 240 }),
    cooldownMin: fc.constantFrom(0, 15, 30, 60),
    priority: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
    dueOffsetMin: fc.option(fc.integer({ min: -120, max: 3000 }), { nil: undefined }),
    dueKind: fc.constantFrom('soft' as const, 'hard' as const),
    floorOffsetMin: fc.option(fc.integer({ min: 0, max: 600 }), { nil: undefined }),
    preferred: fc.option(
      fc.record({
        startMin: fc.integer({ min: 0, max: 800 }),
        length: fc.integer({ min: 60, max: 400 }),
      }),
      { nil: undefined },
    ),
    focusLevel: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  })
  .map((spec): Schedulable => ({
    occurrenceId: `occ-${String(spec.index).padStart(3, '0')}`,
    taskId: `task-${spec.index}`,
    calendarId: 'cal-1',
    activityTypeId: 'cat-work',
    durationMin: spec.durationMin,
    cooldownMin: spec.cooldownMin,
    ...(spec.priority === undefined ? {} : { priority: spec.priority }),
    ...(spec.dueOffsetMin === undefined
      ? {}
      : { dueDate: WINDOW_START + spec.dueOffsetMin, dueKind: spec.dueKind }),
    ...(spec.floorOffsetMin === undefined
      ? {}
      : { manualFloor: WINDOW_START + spec.floorOffsetMin }),
    ...(spec.preferred === undefined
      ? {}
      : {
          preferredRange: {
            startMin: spec.preferred.startMin,
            endMin: Math.min(1440, spec.preferred.startMin + spec.preferred.length),
          },
        }),
    ...(spec.focusLevel === undefined ? {} : { focusLevel: spec.focusLevel }),
  }));

const fixedBlockArbitrary = fc
  .record({
    index: fc.integer({ min: 0, max: 20 }),
    startOffset: fc.integer({ min: 0, max: 400 }),
    durationMin: fc.integer({ min: 15, max: 120 }),
  })
  .map((spec): FixedBlock => ({
    id: `block-${spec.index}`,
    calendarId: 'cal-1',
    interval: {
      start: WINDOW_START + spec.startOffset,
      end: WINDOW_START + spec.startOffset + spec.durationMin,
    },
  }));

/** Fixed blocks must not overlap each other — the database forbids it (M2). */
function disjoint(blocks: readonly FixedBlock[]): FixedBlock[] {
  const ordered = [...blocks].sort((a, b) => a.interval.start - b.interval.start);
  const kept: FixedBlock[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;

  for (const block of ordered) {
    if (block.interval.start >= lastEnd) {
      kept.push(block);
      lastEnd = block.interval.end;
    }
  }
  return kept;
}

function dedupe(schedulables: readonly Schedulable[]): Schedulable[] {
  const seen = new Set<string>();
  return schedulables.filter((s) =>
    seen.has(s.occurrenceId) ? false : (seen.add(s.occurrenceId), true),
  );
}

const scenarioArbitrary = fc
  .record({
    schedulables: fc.array(schedulableArbitrary, { minLength: 1, maxLength: 10 }),
    blocks: fc.array(fixedBlockArbitrary, { maxLength: 4 }),
  })
  .map(({ schedulables, blocks }) =>
    context({ schedulables: dedupe(schedulables), fixedBlocks: disjoint(blocks) }),
  );

describe('the solver never produces an invalid schedule', () => {
  it('always returns placements that pass the hard-constraint validator', () => {
    // The whole of spec §6.2 asserted at once, over randomised input. Candidate
    // slots are filtered before they are scored, so no weighting of the soft
    // terms can produce a violation.
    fc.assert(
      fc.property(scenarioArbitrary, (ctx) => {
        const result = solve(ctx);
        const validation = validateSchedule(ctx, result.placements);

        expect(validation.violations).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it('accounts for every schedulable exactly once', () => {
    // Nothing may be silently dropped: a task is either placed or backlogged.
    fc.assert(
      fc.property(scenarioArbitrary, (ctx) => {
        const result = solve(ctx);
        const accounted = [
          ...result.placements.map((p) => p.occurrenceId),
          ...result.backlog.map((b) => b.occurrenceId),
        ].sort();

        expect(accounted).toEqual(ctx.schedulables.map((s) => s.occurrenceId).sort());
      }),
      { numRuns: 300 },
    );
  });

  it('keeps every placement inside the horizon', () => {
    fc.assert(
      fc.property(scenarioArbitrary, (ctx) => {
        const result = solve(ctx);

        for (const placement of result.placements) {
          expect(placement.interval.start).toBeGreaterThanOrEqual(result.horizon.start);
          expect(placement.interval.end).toBeLessThanOrEqual(result.horizon.end);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('remains valid however the weights are set', () => {
    // The structural guarantee: soft scoring cannot reach a hard constraint,
    // whatever the weight vector says.
    fc.assert(
      fc.property(
        scenarioArbitrary,
        fc.integer({ min: -2_000_000, max: 2_000_000 }),
        fc.integer({ min: -2_000_000, max: 2_000_000 }),
        fc.integer({ min: -2_000_000, max: 2_000_000 }),
        (ctx, preferredMatch, earliness, fragmentation) => {
          const config = withTuning({
            slotWeights: { preferredMatch, earliness, fragmentation },
          });

          const result = solve(ctx, { config });
          expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the solver is deterministic', () => {
  it('produces identical output for identical input', () => {
    // Spec §6.3, and the precondition for §3.3: the client's optimistic schedule
    // and the server's authoritative one must agree.
    fc.assert(
      fc.property(scenarioArbitrary, (ctx) => {
        expect(solve(ctx)).toEqual(solve(ctx));
      }),
      { numRuns: 300 },
    );
  });

  it('produces identical output however the input is ordered', () => {
    fc.assert(
      fc.property(scenarioArbitrary, fc.array(fc.integer()), (ctx, seed) => {
        const shuffled: ScheduleContext = {
          ...ctx,
          schedulables: permute(ctx.schedulables, seed),
          fixedBlocks: permute(ctx.fixedBlocks, seed),
          windows: permute(ctx.windows, seed),
        };

        expect(solve(shuffled)).toEqual(solve(ctx));
      }),
      { numRuns: 300 },
    );
  });

  it('does not mutate its input', () => {
    fc.assert(
      fc.property(scenarioArbitrary, (ctx) => {
        const snapshot = JSON.stringify(ctx);
        solve(ctx);
        expect(JSON.stringify(ctx)).toBe(snapshot);
      }),
      { numRuns: 200 },
    );
  });
});

describe('capacity degrades to the backlog', () => {
  it('backlogs the surplus instead of overlapping when demand exceeds supply', () => {
    // Both windows total 960 minutes; the generator asks for far more.
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 40 }), (count) => {
        const schedulables: Schedulable[] = Array.from({ length: count }, (_, i) => ({
          occurrenceId: `occ-${String(i).padStart(3, '0')}`,
          taskId: `task-${i}`,
          calendarId: 'cal-1',
          activityTypeId: 'cat-work',
          durationMin: 60,
          cooldownMin: 0,
        }));
        const ctx = context({ schedulables, windows: [MONDAY_WINDOW, TUESDAY_WINDOW] });

        const result = solve(ctx);

        expect(result.placements).toHaveLength(16);
        expect(result.backlog).toHaveLength(count - 16);
        expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
        // Every backlog entry carries a reason a user can act on (§6.7).
        for (const entry of result.backlog) {
          expect(entry.reason).toBe('insufficient_remaining_capacity');
        }
      }),
      { numRuns: 20 },
    );
  });

  it('never leaves a hard due date violated, preferring the backlog', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 600 }), (dueOffset) => {
        const ctx = context({
          schedulables: [
            {
              occurrenceId: 'a',
              taskId: 'task-a',
              calendarId: 'cal-1',
              activityTypeId: 'cat-work',
              durationMin: 120,
              cooldownMin: 0,
              dueDate: at('2026-03-23T08:00:00Z') + dueOffset,
              dueKind: 'hard',
            },
          ],
        });

        const result = solve(ctx);
        expect(validateSchedule(ctx, result.placements).violations).toEqual([]);

        // Either it fits before the deadline, or it is backlogged — never late.
        if (result.placements.length > 0) {
          expect(result.placements[0]!.interval.end).toBeLessThanOrEqual(
            at('2026-03-23T08:00:00Z') + dueOffset,
          );
        } else {
          expect(result.backlog).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
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

/**
 * Sequence scenarios (spec §6.2 rule 5).
 *
 * Members share an activity type, so these exercise real placement rather than the
 * degenerate "no window could ever hold this" path — that one is covered by
 * hand in `sequences.test.ts`, where the expected diagnosis can be named.
 */
const memberArbitrary = fc.record({
  durationMin: fc.integer({ min: 15, max: 90 }),
  cooldownMin: fc.constantFrom(0, 15, 30),
  position: fc.integer({ min: 1, max: 6 }),
  priority: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
});

const sequenceScenarioArbitrary = fc
  .record({
    sequences: fc.array(
      fc.record({
        isOrdered: fc.boolean(),
        members: fc.array(memberArbitrary, { minLength: 2, maxLength: 4 }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    lone: fc.array(
      fc.record({
        durationMin: fc.integer({ min: 15, max: 120 }),
        cooldownMin: fc.constantFrom(0, 15),
      }),
      { maxLength: 4 },
    ),
    blocks: fc.array(fixedBlockArbitrary, { maxLength: 3 }),
  })
  .map(({ sequences, lone, blocks }) => {
    const schedulables: Schedulable[] = [];
    const specs: SequenceSpec[] = [];

    sequences.forEach((spec, sequenceIndex) => {
      const sequenceId = `seq-${sequenceIndex}`;
      specs.push({ id: sequenceId, isOrdered: spec.isOrdered });

      spec.members.forEach((memberSpec, memberIndex) => {
        schedulables.push({
          occurrenceId: `${sequenceId}-m${memberIndex}`,
          taskId: `${sequenceId}-t${memberIndex}`,
          calendarId: 'cal-1',
          activityTypeId: 'cat-work',
          durationMin: memberSpec.durationMin,
          cooldownMin: memberSpec.cooldownMin,
          sequenceId,
          sequencePosition: memberSpec.position,
          ...(memberSpec.priority === undefined ? {} : { priority: memberSpec.priority }),
        });
      });
    });

    lone.forEach((spec, index) => {
      schedulables.push({
        occurrenceId: `lone-${index}`,
        taskId: `lone-t${index}`,
        calendarId: 'cal-1',
        activityTypeId: 'cat-work',
        durationMin: spec.durationMin,
        cooldownMin: spec.cooldownMin,
      });
    });

    return context({ schedulables, sequences: specs, fixedBlocks: disjoint(blocks) });
  });

/** The placed members of one sequence, in time order. */
function membersOf(ctx: ScheduleContext, placements: readonly Placement[], sequenceId: string) {
  const members = new Map(
    ctx.schedulables
      .filter((schedulable) => schedulable.sequenceId === sequenceId)
      .map((schedulable) => [schedulable.occurrenceId, schedulable]),
  );

  return placements
    .filter((placement) => members.has(placement.occurrenceId))
    .sort((a, b) => a.interval.start - b.interval.start)
    .map((placement) => ({ placement, schedulable: members.get(placement.occurrenceId)! }));
}

describe('sequences are placed as indivisible blocks', () => {
  it('produces a schedule the validator accepts', () => {
    // Rule 5 in full — contiguous, in order, one window, nothing interleaved —
    // asserted at once over randomised sequences.
    fc.assert(
      fc.property(sequenceScenarioArbitrary, (ctx) => {
        const result = solve(ctx);
        expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('places members back to back, cooldowns included', () => {
    fc.assert(
      fc.property(sequenceScenarioArbitrary, (ctx) => {
        const result = solve(ctx);

        for (const sequence of ctx.sequences) {
          const placed = membersOf(ctx, result.placements, sequence.id);

          for (let i = 1; i < placed.length; i += 1) {
            const previous = placed[i - 1]!.placement;
            expect(placed[i]!.placement.interval.start).toBe(
              previous.interval.end + previous.cooldownMin,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('places every member or none of them', () => {
    // Half a sequence is not a partial success; it is an invalid schedule.
    fc.assert(
      fc.property(sequenceScenarioArbitrary, (ctx) => {
        const result = solve(ctx);
        const backlogged = new Set(result.backlog.map((entry) => entry.occurrenceId));

        for (const sequence of ctx.sequences) {
          const all = ctx.schedulables.filter(
            (schedulable) => schedulable.sequenceId === sequence.id,
          );
          const placed = membersOf(ctx, result.placements, sequence.id).length;

          expect(placed === 0 || placed === all.length).toBe(true);
          if (placed === 0) {
            for (const schedulable of all)
              expect(backlogged.has(schedulable.occurrenceId)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps ordered members in position order', () => {
    fc.assert(
      fc.property(sequenceScenarioArbitrary, (ctx) => {
        const result = solve(ctx);

        for (const sequence of ctx.sequences) {
          if (!sequence.isOrdered) continue;
          const placed = membersOf(ctx, result.placements, sequence.id);

          for (let i = 1; i < placed.length; i += 1) {
            // Non-decreasing rather than increasing: two members may share a
            // position, and the id then breaks the tie.
            expect(placed[i]!.schedulable.sequencePosition).toBeGreaterThanOrEqual(
              placed[i - 1]!.schedulable.sequencePosition!,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never lets a foreign task fall inside a block', () => {
    fc.assert(
      fc.property(sequenceScenarioArbitrary, (ctx) => {
        const result = solve(ctx);

        for (const sequence of ctx.sequences) {
          const placed = membersOf(ctx, result.placements, sequence.id);
          if (placed.length === 0) continue;

          const first = placed[0]!.placement;
          const last = placed[placed.length - 1]!.placement;
          // The trailing cooldown belongs to the block: a task started inside
          // it has interrupted the sequence just as surely.
          const span = { start: first.interval.start, end: last.interval.end + last.cooldownMin };
          const members = new Set(placed.map((entry) => entry.placement.occurrenceId));

          for (const placement of result.placements) {
            if (members.has(placement.occurrenceId)) continue;
            expect(
              placement.interval.start >= span.end || placement.interval.end <= span.start,
            ).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps each block inside a single window', () => {
    fc.assert(
      fc.property(sequenceScenarioArbitrary, (ctx) => {
        const result = solve(ctx);

        for (const sequence of ctx.sequences) {
          const placed = membersOf(ctx, result.placements, sequence.id);
          if (placed.length === 0) continue;

          const first = placed[0]!.placement;
          const last = placed[placed.length - 1]!.placement;
          const containing = ctx.windows.filter(
            (window) =>
              first.interval.start >= window.interval.start &&
              last.interval.end <= window.interval.end,
          );

          expect(containing.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('stays deterministic however the members arrive', () => {
    fc.assert(
      fc.property(sequenceScenarioArbitrary, fc.array(fc.integer()), (ctx, seed) => {
        const shuffled: ScheduleContext = {
          ...ctx,
          schedulables: permute(ctx.schedulables, seed),
          sequences: permute(ctx.sequences, seed),
          windows: permute(ctx.windows, seed),
        };

        expect(solve(shuffled)).toEqual(solve(ctx));
      }),
      { numRuns: 200 },
    );
  });
});

describe('the sequence generator exercises real placement', () => {
  it('places most of the scenarios it produces', () => {
    // Guards the properties above against passing vacuously: if the generator
    // drifted into producing only unplaceable blocks, every "members are
    // contiguous" assertion would hold over an empty list and prove nothing.
    const scenarios = fc.sample(sequenceScenarioArbitrary, { numRuns: 200, seed: 20260828 });

    let placedSequences = 0;
    let totalSequences = 0;

    for (const ctx of scenarios) {
      const result = solve(ctx);
      for (const sequence of ctx.sequences) {
        totalSequences += 1;
        if (membersOf(ctx, result.placements, sequence.id).length > 0) placedSequences += 1;
      }
    }

    expect(totalSequences).toBeGreaterThan(200);
    // Around 94% place with this seed; the bound is loose enough to survive a
    // generator tweak but tight enough to catch the properties going hollow.
    expect(placedSequences / totalSequences).toBeGreaterThan(0.8);
  });
});
