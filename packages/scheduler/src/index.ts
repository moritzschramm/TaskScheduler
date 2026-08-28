/**
 * The scheduling engine (spec §6).
 *
 * A **pure function of its inputs** (spec §3.3): plain data in, plain data out,
 * `now` passed explicitly, no wall-clock reads and no randomness (spec §6.3).
 * It must never import DB or HTTP code — enforced by lint (`eslint.config.js`)
 * and by `test/purity.test.ts`.
 *
 * M3 delivers the types, the hard-constraint validator and the determinism
 * foundation. Placement and scoring arrive in M4, sequences and capacity in M5.
 */

export const SCHEDULER_PACKAGE = '@ambitime/scheduler' as const;

export * from './time.js';
export * from './types.js';
export * from './ordering.js';
export * from './windows.js';
export * from './diagnostics.js';
export * from './validator.js';
