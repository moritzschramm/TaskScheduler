/**
 * The scheduling engine (spec §6).
 *
 * A **pure function of its inputs** (spec §3.3): plain data in, plain data out,
 * `now` passed explicitly, no wall-clock reads and no randomness (spec §6.3).
 * It must never import DB or HTTP code — enforced by lint (`eslint.config.js`)
 * and by `test/purity.test.ts`.
 *
 * M3 delivered the types, the hard-constraint validator and the determinism
 * foundation. M4 added placement, the modular scoring policy, the horizon model
 * and the backlog. M5 completes the engine with uninterruptible sequences,
 * capacity and the chronic-postponement signal.
 */

export const SCHEDULER_PACKAGE = '@ambitime/scheduler' as const;

export * from './time.js';
export * from './types.js';
export * from './local-days.js';
export * from './ordering.js';
export * from './windows.js';
export * from './spans.js';
export * from './diagnostics.js';
export * from './sequences.js';
export * from './validator.js';
export * from './fixed-point.js';
export * from './config.js';
export * from './horizon.js';
export * from './backlog.js';
export * from './capacity.js';
export * from './deferral.js';
export * from './scoring/policy.js';
export * from './scoring/default-policy.js';
export * from './placement/slots.js';
export * from './placement/solve.js';
