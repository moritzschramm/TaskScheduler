import { describe, expect, it } from 'vitest';
import {
  assertPolicyMatchesWeights,
  bias,
  constrainedness,
  DEFAULT_TUNING,
  defaultScoringPolicy,
  earliness,
  explainOrder,
  explainSlot,
  fragmentation,
  ONE,
  orderScore,
  preferredMatch,
  priority,
  slotScore,
  solve,
  urgency,
  weight,
  withTuning,
  type OrderContext,
  type ScoringPolicy,
  type SlotContext,
  type TuningConfig,
} from '../src/index.js';
import { at, context, MONDAY_WINDOW, schedulable } from './support/fixtures.js';

/**
 * Golden tests for the default policy (spec §6.5), plus the modularity the
 * review focus asks about: the *term structure* must be replaceable, not only
 * the weights.
 *
 * The pinned numbers exist so that a change to a weight or a term shows up as a
 * diff here rather than as a mysterious change in placement.
 */

const now = at('2026-03-23T08:00:00Z');
const horizon = { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-30T00:00:00Z') };

function orderContext(overrides: Partial<OrderContext> = {}): OrderContext {
  return {
    schedulable: schedulable({ occurrenceId: 'a', durationMin: 60 }),
    now,
    horizon,
    feasibleWindowMinutes: 960,
    config: DEFAULT_TUNING,
    ...overrides,
  };
}

function slotContext(overrides: Partial<SlotContext> = {}): SlotContext {
  return {
    schedulable: schedulable({ occurrenceId: 'a', durationMin: 60 }),
    candidate: { start: MONDAY_WINDOW.interval.start, end: MONDAY_WINDOW.interval.start + 60 },
    cooldownMin: 0,
    window: MONDAY_WINDOW,
    calendar: { id: 'cal-1', timeZone: 'Europe/Berlin' },
    horizon,
    occupied: [],
    config: DEFAULT_TUNING,
    ...overrides,
  };
}

describe('stage-1 terms (spec §6.5)', () => {
  it('scores urgency 1 when slack is zero and 0 with no due date', () => {
    // U = 1 / (1 + slack_hours): due exactly when the task would finish.
    const exactlyDue = urgency(
      orderContext({
        schedulable: schedulable({ occurrenceId: 'a', durationMin: 60, dueDate: now + 60 }),
      }),
    );
    expect(exactlyDue).toBe(ONE);

    expect(urgency(orderContext())).toBe(0);
  });

  it('decays urgency as slack grows', () => {
    const oneHourSlack = urgency(
      orderContext({
        schedulable: schedulable({ occurrenceId: 'a', durationMin: 60, dueDate: now + 120 }),
      }),
    );
    const oneDaySlack = urgency(
      orderContext({
        schedulable: schedulable({ occurrenceId: 'a', durationMin: 60, dueDate: now + 60 + 1440 }),
      }),
    );

    // 60 / (60 + 60) = 0.5, and 60 / (60 + 1440) = 0.04.
    expect(oneHourSlack).toBe(500_000);
    expect(oneDaySlack).toBe(40_000);
    expect(oneDaySlack).toBeLessThan(oneHourSlack);
  });

  it('treats an overdue task as maximally urgent', () => {
    const overdue = urgency(
      orderContext({
        schedulable: schedulable({ occurrenceId: 'a', durationMin: 60, dueDate: now - 600 }),
      }),
    );
    expect(overdue).toBe(ONE);
  });

  it('normalises priority across the configured range', () => {
    const mid = priority(
      orderContext({ schedulable: schedulable({ occurrenceId: 'a', priority: 3 }) }),
    );
    const top = priority(
      orderContext({ schedulable: schedulable({ occurrenceId: 'a', priority: 5 }) }),
    );
    const bottom = priority(
      orderContext({ schedulable: schedulable({ occurrenceId: 'a', priority: 1 }) }),
    );

    expect(bottom).toBe(0);
    expect(mid).toBe(500_000);
    expect(top).toBe(ONE);
    expect(priority(orderContext())).toBe(0);
  });

  it('scores constrainedness as the share of the activity type’s window it needs', () => {
    // Most-constrained-first: 60 of 960 available minutes.
    expect(constrainedness(orderContext())).toBe(62_500);
    // A task needing more than exists clamps to 1 rather than exceeding it.
    expect(constrainedness(orderContext({ feasibleWindowMinutes: 30 }))).toBe(ONE);
    expect(constrainedness(orderContext({ feasibleWindowMinutes: 0 }))).toBe(0);
  });

  it('composes the stage-1 score as 0.5·U + 0.3·P + 0.2·C', () => {
    const ctx = orderContext({
      schedulable: schedulable({
        occurrenceId: 'a',
        durationMin: 60,
        dueDate: now + 60,
        priority: 3,
      }),
    });

    const breakdown = explainOrder(defaultScoringPolicy, DEFAULT_TUNING, ctx);
    expect(breakdown).toEqual({
      urgency: { term: 1_000_000, weight: 500_000, contribution: 500_000_000_000 },
      priority: { term: 500_000, weight: 300_000, contribution: 150_000_000_000 },
      constrainedness: { term: 62_500, weight: 200_000, contribution: 12_500_000_000 },
    });

    expect(orderScore(defaultScoringPolicy, DEFAULT_TUNING, ctx)).toBe(662_500_000_000);
  });
});

describe('stage-2 terms (spec §6.5)', () => {
  it('scores earliness 1 at the horizon start and decays across it', () => {
    const atStart = earliness(
      slotContext({ candidate: { start: horizon.start, end: horizon.start + 60 } }),
    );
    const halfway = earliness(
      slotContext({
        candidate: {
          start: horizon.start + (horizon.end - horizon.start) / 2,
          end: horizon.start + (horizon.end - horizon.start) / 2 + 60,
        },
      }),
    );

    expect(atStart).toBe(ONE);
    expect(halfway).toBe(500_000);
  });

  it('scores no preferred match when the task expresses no preference', () => {
    expect(preferredMatch(slotContext())).toBe(0);
  });

  it('scores a full preferred match when the placement sits inside the range', () => {
    // 09:00–10:00 Berlin, which is 08:00–09:00Z on this date.
    const score = preferredMatch(
      slotContext({
        schedulable: schedulable({
          occurrenceId: 'a',
          durationMin: 60,
          preferredRange: { startMin: 9 * 60, endMin: 12 * 60 },
        }),
      }),
    );

    expect(score).toBe(ONE);
  });

  it('scores a partial preferred match proportionally', () => {
    // Placement runs 09:00–10:00 local; only its first half-hour is preferred.
    const score = preferredMatch(
      slotContext({
        schedulable: schedulable({
          occurrenceId: 'a',
          durationMin: 60,
          preferredRange: { startMin: 9 * 60, endMin: 9 * 60 + 30 },
        }),
      }),
    );

    expect(score).toBe(500_000);
  });

  it('rewards a matching focus profile and penalises a mismatched one', () => {
    const matched = preferredMatch(
      slotContext({
        schedulable: schedulable({ occurrenceId: 'a', durationMin: 60, focusLevel: 5 }),
        window: { ...MONDAY_WINDOW, focusLevel: 5 },
      }),
    );
    const mismatched = preferredMatch(
      slotContext({
        schedulable: schedulable({ occurrenceId: 'a', durationMin: 60, focusLevel: 5 }),
        window: { ...MONDAY_WINDOW, focusLevel: 1 },
      }),
    );

    expect(matched).toBe(ONE);
    expect(mismatched).toBe(0);
  });

  it('charges nothing for fragmentation when a placement is flush', () => {
    // Flush to the window start, with hours of usable space after it.
    expect(fragmentation(slotContext())).toBe(0);
  });

  it('charges for a sliver too small to use', () => {
    // Starts 10 minutes into the window, stranding a gap under the 15-minute
    // minimum. 10 stranded of a possible 30 → one third.
    const score = fragmentation(
      slotContext({
        candidate: {
          start: MONDAY_WINDOW.interval.start + 10,
          end: MONDAY_WINDOW.interval.start + 70,
        },
      }),
    );

    expect(score).toBe(333_333);
  });

  it('charges nothing for a gap that remains usable', () => {
    const score = fragmentation(
      slotContext({
        candidate: {
          start: MONDAY_WINDOW.interval.start + 60,
          end: MONDAY_WINDOW.interval.start + 120,
        },
      }),
    );

    expect(score).toBe(0);
  });

  it('scores the bias 1 exactly on the repositioned time, and decays by the hour', () => {
    // §7.3's `manual_bias`: where the user actually dropped the task.
    const start = MONDAY_WINDOW.interval.start;
    const biased = (manualBias: number, candidateStart: number) =>
      bias(
        slotContext({
          schedulable: schedulable({ occurrenceId: 'a', durationMin: 60, manualBias }),
          candidate: { start: candidateStart, end: candidateStart + 60 },
        }),
      );

    expect(biased(start, start)).toBe(ONE);
    expect(biased(start, start + 60)).toBe(ONE / 2);
    // Symmetric: a slot an hour before the preferred time is no better than one
    // an hour after it.
    expect(biased(start + 120, start + 60)).toBe(ONE / 2);
  });

  it('scores nothing for a task nobody repositioned', () => {
    // The term is additive, so an untouched schedule scores exactly as it did
    // before the term existed — which is why §6.5's goldens below still hold.
    expect(bias(slotContext())).toBe(0);
  });

  it('composes the stage-2 score as 0.5·Pr + 0.2·E − 0.3·F, plus the bias of §7.3', () => {
    const ctx = slotContext();
    const breakdown = explainSlot(defaultScoringPolicy, DEFAULT_TUNING, ctx);

    // Fragmentation carries the minus sign in its weight, so terms stay
    // non-negative and no per-term sign convention is needed.
    expect(breakdown['fragmentation']?.weight).toBe(-300_000);
    expect(breakdown['bias']?.contribution).toBe(0);
    expect(slotScore(defaultScoringPolicy, DEFAULT_TUNING, ctx)).toBe(
      breakdown['preferredMatch']!.contribution +
        breakdown['earliness']!.contribution +
        breakdown['fragmentation']!.contribution,
    );
  });
});

describe('all scoring is integer arithmetic (spec §6.3)', () => {
  it('produces integer terms and integer composite scores', () => {
    // Floating point must never decide placement; every comparison the solver
    // makes is between integers.
    const ctx = orderContext({
      schedulable: schedulable({
        occurrenceId: 'a',
        durationMin: 37,
        dueDate: now + 271,
        priority: 4,
      }),
      feasibleWindowMinutes: 913,
    });

    for (const { term, contribution } of Object.values(
      explainOrder(defaultScoringPolicy, DEFAULT_TUNING, ctx),
    )) {
      expect(Number.isInteger(term)).toBe(true);
      expect(Number.isInteger(contribution)).toBe(true);
    }

    const score = orderScore(defaultScoringPolicy, DEFAULT_TUNING, ctx);
    expect(Number.isInteger(score)).toBe(true);
    expect(Math.abs(score)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('converts fractional weights once, at configuration', () => {
    expect(weight(0.5)).toBe(500_000);
    expect(weight(-0.3)).toBe(-300_000);
    expect(Number.isInteger(weight(0.333))).toBe(true);
  });
});

describe('tuning changes visibly change the schedule (spec §15)', () => {
  it('moves a placement when the preferred-match weight is removed', () => {
    const task = schedulable({
      occurrenceId: 'a',
      durationMin: 60,
      preferredRange: { startMin: 13 * 60, endMin: 15 * 60 },
    });
    const ctx = context({ schedulables: [task] });

    const withPreference = solve(ctx);
    const withoutPreference = solve(ctx, {
      config: withTuning({ slotWeights: { preferredMatch: 0 } }),
    });

    // With the term weighted, the task moves to its preferred afternoon; with
    // the weight at zero, earliness wins and it returns to the window start.
    expect(withPreference.placements[0]?.interval.start).toBe(at('2026-03-23T12:00:00Z'));
    expect(withoutPreference.placements[0]?.interval.start).toBe(MONDAY_WINDOW.interval.start);
  });

  it('changes the placement order when the priority weight dominates', () => {
    // Urgency 1.0 (due exactly when it would finish) against priority 1.0 with
    // no deadline at all — the cleanest head-to-head between the two terms.
    const urgentLowPriority = schedulable({
      occurrenceId: 'a-urgent',
      durationMin: 60,
      dueDate: at('2026-03-23T07:00:00Z'),
      dueKind: 'soft',
      priority: 1,
    });
    const relaxedHighPriority = schedulable({
      occurrenceId: 'b-important',
      durationMin: 60,
      priority: 5,
    });
    const ctx = context({ schedulables: [urgentLowPriority, relaxedHighPriority] });

    const byUrgency = solve(ctx);
    const byPriority = solve(ctx, {
      config: withTuning({ orderWeights: { urgency: weight(0.1), priority: weight(0.9) } }),
    });

    expect(byUrgency.placements[0]?.occurrenceId).toBe('a-urgent');
    expect(byPriority.placements[0]?.occurrenceId).toBe('b-important');
  });

  it('changes the horizon when the configured length changes', () => {
    const oneWeek = solve(context({ horizon: { start: 0, end: 0 } }), {
      config: withTuning({ hardHorizonWeeks: 1 }),
    });
    const threeWeeks = solve(context({ horizon: { start: 0, end: 0 } }), {
      config: withTuning({ hardHorizonWeeks: 3 }),
    });

    expect(threeWeeks.horizon.end).toBeGreaterThan(oneWeek.horizon.end);
  });
});

describe('the policy structure is replaceable, not just the weights', () => {
  it('accepts a policy with entirely different terms', () => {
    // Spec §6.5: "the entire ScoringPolicy term structure is replaceable".
    const latestFirst: ScoringPolicy = {
      name: 'latest-first',
      orderTerms: { alphabetical: ({ schedulable: s }) => (s.occurrenceId < 'm' ? ONE : 0) },
      slotTerms: {
        lateness: ({ candidate, horizon: h }) =>
          Math.round(((candidate.start - h.start) * ONE) / (h.end - h.start)),
      },
    };
    // Built directly rather than through `withTuning`, which *merges* weights:
    // a policy with a different term structure needs its whole weight vector
    // replaced, and the mismatch check below is what makes that explicit.
    const config: TuningConfig = {
      ...DEFAULT_TUNING,
      orderWeights: { alphabetical: weight(1) },
      slotWeights: { lateness: weight(1) },
    };

    const task = schedulable({ occurrenceId: 'a', durationMin: 60 });
    const result = solve(context({ schedulables: [task] }), { policy: latestFirst, config });

    // A policy that prefers late slots parks the task at the end of the last
    // window, which the default policy would never do.
    expect(result.placements[0]?.interval.end).toBe(at('2026-03-24T16:00:00Z'));
  });

  it('rejects a term with no weight', () => {
    // Silently contributing nothing would look like a tuning change that had no
    // effect, which is miserable to debug.
    const policy: ScoringPolicy = {
      ...defaultScoringPolicy,
      orderTerms: { ...defaultScoringPolicy.orderTerms, novel: () => ONE },
    };

    expect(() => assertPolicyMatchesWeights(policy, DEFAULT_TUNING)).toThrow(/no weight: novel/);
  });

  it('rejects a weight for a term that does not exist', () => {
    const config = withTuning({
      orderWeights: { ...DEFAULT_TUNING.orderWeights, ghost: weight(1) },
    });

    expect(() => assertPolicyMatchesWeights(defaultScoringPolicy, config)).toThrow(
      /unknown terms: ghost/,
    );
  });

  it('surfaces the mismatch through solve rather than silently misbehaving', () => {
    const config = withTuning({
      orderWeights: { ...DEFAULT_TUNING.orderWeights, ghost: weight(1) },
    });

    expect(() => solve(context(), { config })).toThrow(/unknown terms/);
  });
});
