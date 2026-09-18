import { ONE, type CompositeScore, type Score } from '../fixed-point.js';
import type { TuningConfig } from '../config.js';
import type { Instant, Interval } from '../time.js';
import type { CalendarSpec, ResolvedWindow, Schedulable } from '../types.js';

/**
 * The scoring policy interface (spec §6.5).
 *
 * "Modular by design": a policy is a set of **named term functions**, each
 * returning a normalised contribution, plus a **weight vector** keyed by those
 * same names. Terms and weights are both swappable — a different policy may add
 * terms, drop them, or replace the structure entirely without the solver
 * changing, because the solver only ever asks for "the composite score".
 */

/** What a Stage-1 term may look at when ordering tasks. */
export interface OrderContext {
  schedulable: Schedulable;
  now: Instant;
  horizon: Interval;
  /**
   * Total minutes of window this schedulable's activity type has in the horizon.
   * Drives the most-constrained-first term.
   */
  feasibleWindowMinutes: number;
  config: TuningConfig;
}

/** What a Stage-2 term may look at when choosing a slot for one task. */
export interface SlotContext {
  schedulable: Schedulable;
  /** The proposed placement, excluding the cooldown that follows it. */
  candidate: Interval;
  cooldownMin: number;
  window: ResolvedWindow;
  calendar: CalendarSpec;
  horizon: Interval;
  /** Footprints already committed in this window, ordered and disjoint. */
  occupied: readonly Interval[];
  config: TuningConfig;
}

/** A named contribution in `[0, ONE]`. Always non-negative; sign lives in the weight. */
export type ScoreTerm<C> = (context: C) => Score;

export interface ScoringPolicy {
  name: string;
  orderTerms: Readonly<Record<string, ScoreTerm<OrderContext>>>;
  slotTerms: Readonly<Record<string, ScoreTerm<SlotContext>>>;
}

/**
 * Rejects a policy whose terms and weights disagree.
 *
 * A weight naming a term that does not exist silently does nothing, and a term
 * with no weight silently contributes nothing — both would look like a tuning
 * change that "had no effect", which is a miserable thing to debug.
 */
export function assertPolicyMatchesWeights(policy: ScoringPolicy, config: TuningConfig): void {
  const check = (
    stage: string,
    terms: Readonly<Record<string, unknown>>,
    weights: Readonly<Record<string, number>>,
  ) => {
    const termNames = Object.keys(terms).sort();
    const weightNames = Object.keys(weights).sort();

    const missingWeights = termNames.filter((name) => !(name in weights));
    const unknownWeights = weightNames.filter((name) => !(name in terms));

    if (missingWeights.length > 0) {
      throw new Error(
        `Scoring policy "${policy.name}" has ${stage} terms with no weight: ${missingWeights.join(', ')}`,
      );
    }
    if (unknownWeights.length > 0) {
      throw new Error(
        `Scoring policy "${policy.name}" has ${stage} weights for unknown terms: ${unknownWeights.join(', ')}`,
      );
    }
  };

  check('order', policy.orderTerms, config.orderWeights);
  check('slot', policy.slotTerms, config.slotWeights);
}

/**
 * Weighted sum of named terms.
 *
 * Terms are evaluated in sorted name order. Integer addition is exact and
 * order-independent, so this is not needed for correctness — it is here so that
 * a term with a side effect (a future instrumented policy, say) cannot make the
 * result depend on object key order.
 */
function composite<C>(
  terms: Readonly<Record<string, ScoreTerm<C>>>,
  weights: Readonly<Record<string, number>>,
  context: C,
): CompositeScore {
  let total = 0;
  for (const name of Object.keys(terms).sort()) {
    total += (weights[name] ?? 0) * terms[name]!(context);
  }
  return total;
}

/** Stage-1: which task picks a slot first (spec §6.5). Higher goes first. */
export function orderScore(
  policy: ScoringPolicy,
  config: TuningConfig,
  context: OrderContext,
): CompositeScore {
  return composite(policy.orderTerms, config.orderWeights, context);
}

/** Stage-2: which slot that task takes (spec §6.5). Higher wins. */
export function slotScore(
  policy: ScoringPolicy,
  config: TuningConfig,
  context: SlotContext,
): CompositeScore {
  return composite(policy.slotTerms, config.slotWeights, context);
}

/** Per-term breakdown, for golden tests and for explaining a placement to a user. */
export function explainOrder(
  policy: ScoringPolicy,
  config: TuningConfig,
  context: OrderContext,
): Record<string, { term: Score; weight: number; contribution: number }> {
  return explain(policy.orderTerms, config.orderWeights, context);
}

export function explainSlot(
  policy: ScoringPolicy,
  config: TuningConfig,
  context: SlotContext,
): Record<string, { term: Score; weight: number; contribution: number }> {
  return explain(policy.slotTerms, config.slotWeights, context);
}

function explain<C>(
  terms: Readonly<Record<string, ScoreTerm<C>>>,
  weights: Readonly<Record<string, number>>,
  context: C,
): Record<string, { term: Score; weight: number; contribution: number }> {
  const breakdown: Record<string, { term: Score; weight: number; contribution: number }> = {};
  for (const name of Object.keys(terms).sort()) {
    const term = terms[name]!(context);
    const termWeight = weights[name] ?? 0;
    breakdown[name] = { term, weight: termWeight, contribution: termWeight * term };
  }
  return breakdown;
}

export { ONE };
