/**
 * The scheduling engine (spec §6).
 *
 * This package is a **pure function of its inputs** (spec §3.3): plain data in,
 * plain data out, `now` passed explicitly, no wall-clock reads and no
 * randomness (spec §6.3). It must never import DB or HTTP code — that rule is
 * enforced by lint (`eslint.config.js`) and by `test/purity.test.ts`.
 *
 * Deliberately empty at M0: the engine is built headless in M3–M5.
 */

/** Marker export so the package has a public surface before M3 fills it in. */
export const SCHEDULER_PACKAGE = '@ambitime/scheduler' as const;
