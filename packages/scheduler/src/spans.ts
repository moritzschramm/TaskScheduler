import { byInt, chain, sorted } from './ordering.js';
import type { Interval } from './time.js';

/**
 * Interval algebra over half-open `[start, end)` ranges (spec §5.1).
 *
 * Small enough to inline, kept separate because two very different callers need
 * the same answers: the capacity report measures the *shape* of a category's
 * availability (§6.6), and the solver asks whether any window is long enough to
 * hold a sequence in one piece (§6.7). Both must agree, so both use this.
 */

/**
 * The span something occupies, including any cooldown reserved after it.
 *
 * Structural rather than typed to `FixedBlock` or `Placement`, because both
 * have the shape and both mean the same thing by it (spec §6.2 rule 3) — and
 * an interval module that imported the domain types would be the wrong way
 * round.
 */
export function footprint(subject: { interval: Interval; cooldownMin?: number }): Interval {
  return {
    start: subject.interval.start,
    end: subject.interval.end + (subject.cooldownMin ?? 0),
  };
}

/** Merges overlapping or touching intervals, so minutes are never counted twice. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const ordered = sorted(
    intervals,
    chain<Interval>(
      byInt((interval) => interval.start),
      byInt((interval) => interval.end),
    ),
  );

  const merged: Interval[] = [];
  for (const interval of ordered) {
    if (interval.end <= interval.start) continue;

    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

/**
 * What is left of `available` once `occupied` is removed.
 *
 * Each available interval is carved **independently**, so a free run never
 * crosses from one into another even when they abut. That is what makes the
 * result usable as the "single window" of §6.2 rule 5: two back-to-back windows
 * do not compose into one long enough to hold a sequence.
 */
export function freeSpans(
  available: readonly Interval[],
  occupied: readonly Interval[],
): Interval[] {
  const blocks = mergeIntervals(occupied);
  const spans: Interval[] = [];

  for (const window of sorted(
    available,
    chain<Interval>(
      byInt((interval) => interval.start),
      byInt((interval) => interval.end),
    ),
  )) {
    let cursor = window.start;

    for (const block of blocks) {
      if (block.end <= cursor) continue;
      if (block.start >= window.end) break;

      if (block.start > cursor) spans.push({ start: cursor, end: block.start });
      cursor = block.end;
      if (cursor >= window.end) break;
    }

    if (cursor < window.end) spans.push({ start: cursor, end: window.end });
  }

  return spans;
}

/** Total length of the intervals, which must already be disjoint. */
export function totalMinutes(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
}

/** The longest single interval, or 0 when there are none. */
export function maxSpanMinutes(intervals: readonly Interval[]): number {
  return intervals.reduce((best, interval) => Math.max(best, interval.end - interval.start), 0);
}
