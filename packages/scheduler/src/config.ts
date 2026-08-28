import { weight } from './fixed-point.js';

/**
 * The tuning surface (spec §15).
 *
 * Every value the spec expects to change during development lives here and
 * nowhere else — operating-brief rule #7 forbids inlining them. The defaults
 * are §6.5's draft policy, which is explicitly "to be tuned".
 *
 * Weights are written as the fractions the spec uses and converted to fixed
 * point once, here, so the solver only ever compares integers (§6.3).
 */
export interface TuningConfig {
  /** Hard horizon length in weeks (spec §6.1, default two). */
  hardHorizonWeeks: number;
  /** ISO weekday the user's week starts on: 1 = Monday … 7 = Sunday (§13). */
  firstDayOfWeek: number;
  /**
   * Candidate placement starts are generated on this grid, matching the 15
   * minute drag grid the UI snaps to (§13).
   */
  slotGranularityMin: number;
  /**
   * A gap shorter than this is treated as unusable, and leaving one is what the
   * fragmentation term penalises (§6.5). Roughly "the shortest task worth
   * scheduling".
   */
  minUsableGapMin: number;
  /** Priority → `[0,1]` mapping: the inclusive range of user-facing values (§15). */
  priorityRange: { min: number; max: number };
  /** How many weeks past the hard horizon the coarse planner will assign (§6.1). */
  backlogPlanningWeeks: number;

  /** Stage-1 weights: which task picks a slot first (§6.5). */
  orderWeights: Record<string, number>;
  /** Stage-2 weights: which slot that task takes (§6.5). */
  slotWeights: Record<string, number>;
}

/**
 * Spec §6.5's draft policy.
 *
 * `fragmentation` carries a negative weight because §6.5 subtracts it
 * (`0.5·Pr + 0.2·E − 0.3·F`); terms themselves are always non-negative, so the
 * sign lives in one place rather than being an per-term convention.
 */
export const DEFAULT_TUNING: TuningConfig = {
  hardHorizonWeeks: 2,
  firstDayOfWeek: 1,
  slotGranularityMin: 15,
  minUsableGapMin: 15,
  priorityRange: { min: 1, max: 5 },
  backlogPlanningWeeks: 12,

  orderWeights: {
    urgency: weight(0.5),
    priority: weight(0.3),
    constrainedness: weight(0.2),
  },
  slotWeights: {
    preferredMatch: weight(0.5),
    earliness: weight(0.2),
    fragmentation: weight(-0.3),
  },
};

/**
 * Applies partial overrides to the defaults, for tests and per-tenant tuning.
 *
 * Weight maps are **merged**, which is what you want when adjusting one weight
 * of the default policy. A policy with a different term structure needs its
 * whole vector replaced instead — build the config directly, or
 * `assertPolicyMatchesWeights` will reject the leftover defaults.
 */
export function withTuning(overrides: Partial<TuningConfig> = {}): TuningConfig {
  return {
    ...DEFAULT_TUNING,
    ...overrides,
    priorityRange: { ...DEFAULT_TUNING.priorityRange, ...overrides.priorityRange },
    orderWeights: { ...DEFAULT_TUNING.orderWeights, ...overrides.orderWeights },
    slotWeights: { ...DEFAULT_TUNING.slotWeights, ...overrides.slotWeights },
  };
}
