import { overlaps, type Interval } from '../time.js';
import { byInt, chain, sorted } from '../ordering.js';
import type { TuningConfig } from '../config.js';
import type { Schedulable } from '../types.js';

/**
 * Candidate slot enumeration.
 *
 * This is where every **hard** constraint of spec §6.2 is applied. Scoring
 * never sees a slot that would violate one, so a soft term cannot outrank a
 * hard rule no matter how it is weighted — the guarantee is structural, not a
 * matter of choosing weights carefully.
 *
 * Sequence contiguity (rule 5) is the exception: it constrains a *group*, not a
 * single placement. It is enforced a level up, by collapsing a sequence into a
 * single composite before it reaches here (see `sequences.ts`), so what this
 * module filters is always one indivisible span.
 */

export interface OccupiedFootprint {
  interval: Interval;
  /** Absent for a fixed block, which has no occurrence behind it. */
  occurrenceId?: string;
}

export interface CandidateInput {
  schedulable: Schedulable;
  /** The window being considered; the placement must fit entirely inside it. */
  window: Interval;
  /** Everything already committed that this task must avoid. */
  occupied: readonly OccupiedFootprint[];
  config: TuningConfig;
}

/**
 * Every start at which this task could legally sit inside this window.
 *
 * Starts are generated on the configured grid — the same 15-minute grid the UI
 * drag interaction snaps to (§13) — anchored to the window start, plus the
 * point immediately after each occupied block so tight packing is always
 * available even when a block ends off-grid.
 */
export function candidateIntervals({
  schedulable,
  window,
  occupied,
  config,
}: CandidateInput): Interval[] {
  const { durationMin, cooldownMin } = schedulable;
  if (durationMin <= 0) return [];

  const latestStart = window.end - durationMin;
  if (latestStart < window.start) return [];

  const floor = Math.max(window.start, schedulable.manualFloor ?? window.start);
  const starts = new Set<number>();

  // Grid anchored to the window, so two windows a fractional grid step apart do
  // not produce a different set of offsets.
  const granularity = Math.max(1, config.slotGranularityMin);
  const firstGridStep = Math.ceil((floor - window.start) / granularity);
  for (
    let start = window.start + firstGridStep * granularity;
    start <= latestStart;
    start += granularity
  ) {
    starts.add(start);
  }

  // Flush against the window edge and against every committed block, so the
  // fragmentation term always has a zero-gap option to prefer.
  if (floor <= latestStart) starts.add(floor);
  for (const block of occupied) {
    if (block.interval.end >= floor && block.interval.end <= latestStart) {
      starts.add(block.interval.end);
    }
  }

  const candidates: Interval[] = [];
  for (const start of sorted(
    [...starts],
    byInt((value) => value),
  )) {
    const candidate: Interval = { start, end: start + durationMin };
    if (isFeasible(candidate, cooldownMin, schedulable, window, occupied)) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

/**
 * The hard filters, in one place (spec §6.2 rules 1–4 and 6).
 *
 * Rule 3 is why `cooldownMin` extends the footprint for overlap purposes but
 * not for window containment: the cooldown is reserved against other tasks, not
 * against the clock.
 */
export function isFeasible(
  candidate: Interval,
  cooldownMin: number,
  schedulable: Schedulable,
  window: Interval,
  occupied: readonly OccupiedFootprint[],
): boolean {
  // Rule 1 — inside an availability window of its activity type.
  if (candidate.start < window.start || candidate.end > window.end) return false;

  // Rule 6 — never before a manual floor.
  if (schedulable.manualFloor !== undefined && candidate.start < schedulable.manualFloor) {
    return false;
  }

  // Rule 4 — a hard due date is enforced; a soft one is only scored (§6.5).
  if (
    schedulable.dueKind === 'hard' &&
    schedulable.dueDate !== undefined &&
    candidate.end > schedulable.dueDate
  ) {
    return false;
  }

  // Rules 2 and 3 — no overlap with anything committed, cooldown included.
  const footprint: Interval = { start: candidate.start, end: candidate.end + cooldownMin };
  for (const block of occupied) {
    if (overlaps(footprint, block.interval)) return false;
  }

  return true;
}

/** Occupied footprints that intersect a window, in a deterministic order. */
export function occupiedWithin(
  window: Interval,
  occupied: readonly OccupiedFootprint[],
): OccupiedFootprint[] {
  return sorted(
    occupied.filter((block) => overlaps(block.interval, window)),
    chain(
      byInt((b) => b.interval.start),
      byInt((b) => b.interval.end),
    ),
  );
}
