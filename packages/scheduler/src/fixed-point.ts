/**
 * Fixed-point arithmetic for scoring.
 *
 * Spec §6.5 describes scores as weighted sums of `[0,1]` terms — `0.5·U +
 * 0.3·P + 0.2·C`. Spec §6.3 requires that "floating-point values never
 * participate in comparisons that decide placement". Both hold at once only if
 * the scores being compared are integers, so every term and weight here is a
 * scaled integer and every score is an exact integer sum.
 *
 * This is not pedantry. The client computes an optimistic schedule and the
 * server the authoritative one (spec §3.3); if a tie between two slots came
 * down to the last bit of a float, the two engines could rank them differently
 * on different hardware and the schedules would silently diverge.
 *
 * The only place a fraction appears is reading a human-written weight out of
 * configuration, which happens once, at construction, and never inside a
 * comparison.
 */

/** Terms are integers in `[0, ONE]`, representing `[0, 1]`. */
export const ONE = 1_000_000;

/** Weights use the same scale, so `0.5` is `500_000`. */
export const WEIGHT_ONE = 1_000_000;

/**
 * A term's contribution: an integer in `[0, ONE]`.
 *
 * Terms are always non-negative; a term that should count *against* a slot —
 * fragmentation, in the default policy — is given a negative weight instead, so
 * a term function's range never has to be interpreted per-term.
 */
export type Score = number;

/**
 * A weighted sum of terms. Magnitudes reach `ONE × WEIGHT_ONE` per term, so a
 * handful of terms stays far inside `Number.MAX_SAFE_INTEGER` and every sum is
 * exact.
 */
export type CompositeScore = number;

/** Converts a human-written weight such as `0.5` into fixed point, once. */
export function weight(fraction: number): number {
  return Math.round(fraction * WEIGHT_ONE);
}

/** Clamps to the valid term range. */
export function clampScore(value: number): Score {
  if (value < 0) return 0;
  if (value > ONE) return ONE;
  return value;
}

/**
 * `numerator / denominator` as a term, rounded half-up and clamped.
 *
 * Rounding is specified rather than left to the caller so that two engines
 * computing the same ratio always land on the same integer.
 */
export function ratio(numerator: number, denominator: number): Score {
  if (denominator <= 0) return 0;
  return clampScore(Math.round((numerator * ONE) / denominator));
}

/** `1 − ratio(numerator, denominator)`, for terms that decay with distance. */
export function inverseRatio(numerator: number, denominator: number): Score {
  return clampScore(ONE - ratio(numerator, denominator));
}

/**
 * A reciprocal decay `1 / (1 + x)` where `x` is a non-negative rational
 * `numerator / denominator`, evaluated as `denominator / (denominator +
 * numerator)` to keep it in integers.
 */
export function reciprocalDecay(numerator: number, denominator: number): Score {
  if (denominator <= 0) return 0;
  const positive = Math.max(0, numerator);
  return clampScore(Math.round((denominator * ONE) / (denominator + positive)));
}
