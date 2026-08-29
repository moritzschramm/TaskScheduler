import {
  clampScore,
  inverseRatio,
  ratio,
  reciprocalDecay,
  ONE,
  type Score,
} from '../fixed-point.js';
import { zoneOffsetMinutes, MINUTES_PER_DAY } from '../time.js';
import type { Interval } from '../time.js';
import type { OrderContext, ScoringPolicy, SlotContext } from './policy.js';

/**
 * Spec §6.5's default policy:
 *
 *   order_score = 0.5·U + 0.3·P + 0.2·C
 *   slot_score  = 0.5·Pr + 0.2·E − 0.3·F
 *
 * Weights live in `TuningConfig`; only the term *functions* are here. Swapping
 * this whole object for another is what §6.5 means by the structure being
 * replaceable, not just the weights.
 *
 * One term is added to §6.5's slot draft: `bias`, which is what makes §7.3's
 * `manual_bias` mean anything. See its doc comment below.
 */

/**
 * **U — urgency.** From `slack = due − (now + duration)`, as `1 / (1 +
 * slack_hours)`: past or near-due approaches 1, ample slack approaches 0, and a
 * task with no due date scores 0.
 *
 * Evaluated as `60 / (60 + slack_minutes)` so it stays in integers.
 */
export function urgency({ schedulable, now }: OrderContext): Score {
  if (schedulable.dueDate === undefined) return 0;

  const slackMinutes = schedulable.dueDate - (now + schedulable.durationMin);
  return reciprocalDecay(slackMinutes, 60);
}

/** **P — priority.** The user's value normalised onto `[0,1]` (spec §15). */
export function priority({ schedulable, config }: OrderContext): Score {
  if (schedulable.priority === undefined) return 0;

  const { min, max } = config.priorityRange;
  if (max <= min) return 0;

  return ratio(schedulable.priority - min, max - min);
}

/**
 * **C — constrainedness.** `duration / feasible_window_minutes`, clamped.
 *
 * Most-constrained-first: a task that needs most of the only window it can use
 * should choose before one that fits anywhere.
 */
export function constrainedness({ schedulable, feasibleWindowMinutes }: OrderContext): Score {
  return ratio(schedulable.durationMin, feasibleWindowMinutes);
}

/**
 * **Pr — preferred match.** The fraction of the placement falling inside the
 * task's preferred time-of-day range, or 0 when it expresses no preference.
 *
 * When the task also states a focus level, the window's focus profile modulates
 * the result: a deep-focus task placed in a shallow window scores lower even if
 * the clock times line up.
 */
export function preferredMatch(context: SlotContext): Score {
  const { schedulable, candidate, calendar, window } = context;
  const timeMatch =
    schedulable.preferredRange === undefined
      ? 0
      : ratio(
          minutesInsidePreferredRange(candidate, schedulable.preferredRange, calendar.timeZone),
          candidate.end - candidate.start,
        );

  if (schedulable.focusLevel === undefined || window.focusLevel === undefined) {
    return timeMatch;
  }

  // Distance on the 1–5 scale, inverted: an exact match keeps the full score, a
  // four-level mismatch removes it.
  const focusMatch = inverseRatio(Math.abs(window.focusLevel - schedulable.focusLevel), 4);

  return schedulable.preferredRange === undefined
    ? focusMatch
    : clampScore(Math.round((timeMatch + focusMatch) / 2));
}

/**
 * **E — earliness.** `1 − (slot_start − horizon_start) / horizon_length`; a mild
 * pull toward the front of the horizon, which leaves buffer before due dates.
 */
export function earliness({ candidate, horizon }: SlotContext): Score {
  const horizonLength = horizon.end - horizon.start;
  if (horizonLength <= 0) return ONE;

  return inverseRatio(candidate.start - horizon.start, horizonLength);
}

/**
 * **B — bias.** How near the candidate is to where the user actually put the
 * task: spec §7.3's `manual_bias`, the "preferred" half of a manual reposition.
 *
 * Not one of §6.5's draft terms, and it has to be one of something: §7.3 sets a
 * floor *and* a preference, and a preference nothing reads is not a preference.
 * Without it a repositioned task lands at its floor only because `earliness`
 * happens to pull it there, which holds until the moment two tasks want the
 * same slot — and `SwapTasks`, whose whole content is two tasks wanting each
 * other's, would then be a command that mostly did not swap anything.
 *
 * Shaped as `1 / (1 + hours_away)`, §6.5's own normalisation idiom, so a
 * reposition reads on the same scale as urgency: exactly on it scores 1, an
 * hour out scores a half, a day out is nearly nothing. Distance is symmetric —
 * the floor already forbids the early side, so anything the bias still sees
 * there is a slot the user's own instruction allowed.
 *
 * Zero for a task nobody has repositioned, which is nearly all of them, so an
 * untouched schedule scores exactly as it did before the term existed.
 */
export function bias({ schedulable, candidate }: SlotContext): Score {
  if (schedulable.manualBias === undefined) return 0;

  return reciprocalDecay(Math.abs(candidate.start - schedulable.manualBias), 60);
}

/**
 * **F — fragmentation.** Penalises leaving a gap too small to be usable.
 *
 * Spec §6.5 asks only that "slots flush to a window edge or an existing block
 * score higher (tight packing)" and names the exact definition as a tuning value
 * (§15). This one measures the gaps immediately before and after the candidate:
 * a gap of zero costs nothing, a gap at or beyond `minUsableGapMin` costs
 * nothing because it remains usable, and a sliver in between costs in
 * proportion to how much time it strands.
 *
 * Note the term is non-negative, like every other; §6.5's minus sign lives in
 * the weight.
 */
export function fragmentation(context: SlotContext): Score {
  const { candidate, cooldownMin, window, occupied, config } = context;
  const footprint: Interval = { start: candidate.start, end: candidate.end + cooldownMin };

  const previousEnd = boundaryBefore(footprint.start, window.interval, occupied);
  const nextStart = boundaryAfter(footprint.end, window.interval, occupied);

  const wasted =
    strandedMinutes(footprint.start - previousEnd, config.minUsableGapMin) +
    strandedMinutes(nextStart - footprint.end, config.minUsableGapMin);

  // Two gaps, each able to strand up to `minUsableGapMin - 1` minutes.
  return ratio(wasted, 2 * config.minUsableGapMin);
}

/** A gap is stranded only if it is non-zero and too short to hold anything. */
function strandedMinutes(gap: number, minUsableGapMin: number): number {
  return gap > 0 && gap < minUsableGapMin ? gap : 0;
}

function boundaryBefore(point: number, window: Interval, occupied: readonly Interval[]): number {
  let boundary = window.start;
  for (const block of occupied) {
    if (block.end <= point && block.end > boundary) boundary = block.end;
  }
  return boundary;
}

function boundaryAfter(point: number, window: Interval, occupied: readonly Interval[]): number {
  let boundary = window.end;
  for (const block of occupied) {
    if (block.start >= point && block.start < boundary) boundary = block.start;
  }
  return boundary;
}

/**
 * Minutes of the candidate falling inside a preferred *time-of-day* range.
 *
 * The range is wall-clock ("mornings"), so the candidate is shifted into the
 * calendar's local frame and compared against the range on each local day it
 * touches — a placement spanning local midnight is measured against both.
 *
 * The zone offset is taken once, at the candidate's start. A placement is at
 * most a few hours long, so the only case this approximates is one straddling a
 * DST transition, where the preferred-range overlap would be out by the size of
 * the shift. That is a soft scoring term, not a hard constraint, and the
 * approximation is deterministic.
 */
function minutesInsidePreferredRange(
  candidate: Interval,
  preferred: { startMin: number; endMin: number },
  timeZone: string,
): number {
  const offset = zoneOffsetMinutes(candidate.start, timeZone);
  const localStart = candidate.start + offset;
  const localEnd = candidate.end + offset;

  const firstDayStart = Math.floor(localStart / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  const lastDayStart =
    Math.floor(Math.max(localStart, localEnd - 1) / MINUTES_PER_DAY) * MINUTES_PER_DAY;

  let inside = 0;
  for (let dayStart = firstDayStart; dayStart <= lastDayStart; dayStart += MINUTES_PER_DAY) {
    const overlapStart = Math.max(localStart, dayStart + preferred.startMin);
    const overlapEnd = Math.min(localEnd, dayStart + preferred.endMin);
    if (overlapEnd > overlapStart) inside += overlapEnd - overlapStart;
  }

  return inside;
}

export const defaultScoringPolicy: ScoringPolicy = {
  name: 'spec-6.5-draft',
  orderTerms: { urgency, priority, constrainedness },
  slotTerms: { preferredMatch, earliness, fragmentation, bias },
};
