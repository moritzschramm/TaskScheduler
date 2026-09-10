import { footprint } from './spans.js';
import { overlaps, type Interval } from './time.js';
import { byId, byInt, chain, sorted } from './ordering.js';
import { eligibleWindows, windowContaining } from './windows.js';
import { resolveSequences } from './sequences.js';
import type { Violation, ValidationResult } from './diagnostics.js';
import type { Placement, ResolvedWindow, Schedulable, ScheduleContext } from './types.js';

/**
 * The hard-constraint validator (spec §6.2). A schedule violating any of these
 * is invalid, full stop — soft constraints are scored elsewhere and may be
 * violated, these may not.
 *
 * Order-insensitive by construction: the result depends only on the *set* of
 * placements, never on the order they arrive in. That matters because spec §3.3
 * has the server validate a client-proposed schedule, and the two sides have no
 * reason to agree on array order.
 *
 * Violations are collected rather than thrown on first failure, so a caller
 * sees everything wrong at once.
 */

/** Deterministic output order, so two runs report violations identically. */
const compareViolations = chain<Violation>(
  byInt((v) => v.interval?.start ?? 0),
  byId((v) => v.occurrenceId),
  byId((v) => v.code),
  byId((v) => v.relatedOccurrenceId ?? ''),
  byId((v) => v.relatedBlockId ?? ''),
);

function formatInterval(interval: Interval): string {
  return `[${interval.start}, ${interval.end})`;
}

export function validateSchedule(
  context: ScheduleContext,
  placements: readonly Placement[],
): ValidationResult {
  const violations: Violation[] = [];

  const schedulableByOccurrence = new Map<string, Schedulable>(
    context.schedulables.map((schedulable) => [schedulable.occurrenceId, schedulable]),
  );

  // --- Structural checks first -------------------------------------------
  // A placement referencing nothing, or two placements for one occurrence,
  // would make every rule below ambiguous.
  const seen = new Set<string>();
  const usable: Placement[] = [];

  for (const placement of sorted(
    placements,
    chain(
      byInt((p) => p.interval.start),
      byId((p) => p.occurrenceId),
    ),
  )) {
    if (!schedulableByOccurrence.has(placement.occurrenceId)) {
      violations.push({
        code: 'unknown_occurrence',
        occurrenceId: placement.occurrenceId,
        interval: placement.interval,
        message: `Placement references occurrence ${placement.occurrenceId}, which is not in the schedule context.`,
      });
      continue;
    }

    if (seen.has(placement.occurrenceId)) {
      violations.push({
        code: 'duplicate_placement',
        occurrenceId: placement.occurrenceId,
        interval: placement.interval,
        message: `Occurrence ${placement.occurrenceId} is placed more than once.`,
      });
      continue;
    }

    seen.add(placement.occurrenceId);
    usable.push(placement);
  }

  checkWindowMembership(context, usable, schedulableByOccurrence, violations);
  checkOverlaps(context, usable, violations);
  checkDueDates(usable, schedulableByOccurrence, violations);
  checkManualFloors(usable, schedulableByOccurrence, violations);
  checkSequences(context, usable, schedulableByOccurrence, violations);

  return {
    valid: violations.length === 0,
    violations: sorted(violations, compareViolations),
  };
}

/**
 * Rule 1 — a task is placed within an availability window of its category,
 * week-type overrides already applied by `resolveWindows`.
 *
 * The window must contain the task's own interval. The cooldown that follows is
 * a footprint for *overlap* purposes (rule 3) and is allowed to extend past the
 * window edge — the spec reserves it against other tasks, not against the clock.
 */
function checkWindowMembership(
  context: ScheduleContext,
  placements: readonly Placement[],
  schedulables: ReadonlyMap<string, Schedulable>,
  violations: Violation[],
): void {
  for (const placement of placements) {
    const schedulable = schedulables.get(placement.occurrenceId)!;
    const candidates = eligibleWindows(
      context.windows,
      schedulable.calendarId,
      schedulable.categoryId,
    );
    const window = windowContaining(candidates, placement.interval);

    if (!window) {
      violations.push({
        code: 'outside_availability_window',
        occurrenceId: placement.occurrenceId,
        interval: placement.interval,
        message:
          candidates.length === 0
            ? `Task ${schedulable.taskId} is placed at ${formatInterval(placement.interval)} but category ${schedulable.categoryId} has no availability window in this horizon.`
            : `Task ${schedulable.taskId} is placed at ${formatInterval(placement.interval)}, which is not contained by any availability window of category ${schedulable.categoryId}.`,
      });
    }
  }
}

/**
 * Rules 2 and 3 — no overlap between placements, or between a placement and a
 * fixed block, with the cooldown counted as part of the footprint **on both
 * sides**: a placement may not run into a block, and may not start inside the
 * cooldown reserved after one.
 *
 * Compared pairwise over a sorted copy, so the same pair is reported once and
 * always in the same direction regardless of input order.
 */
function checkOverlaps(
  context: ScheduleContext,
  placements: readonly Placement[],
  violations: Violation[],
): void {
  const ordered = sorted(
    placements,
    chain(
      byInt((p) => p.interval.start),
      byId((p) => p.occurrenceId),
    ),
  );

  for (let i = 0; i < ordered.length; i += 1) {
    const first = ordered[i]!;
    const firstFootprint = footprint(first);

    for (let j = i + 1; j < ordered.length; j += 1) {
      const second = ordered[j]!;
      // Sorted by start, so once a later placement begins after this one's
      // footprint ends, no subsequent one can overlap it either.
      if (second.interval.start >= firstFootprint.end) break;

      if (overlaps(first.interval, second.interval)) {
        violations.push({
          code: 'placement_overlap',
          occurrenceId: first.occurrenceId,
          relatedOccurrenceId: second.occurrenceId,
          interval: first.interval,
          message: `Occurrences ${first.occurrenceId} at ${formatInterval(first.interval)} and ${second.occurrenceId} at ${formatInterval(second.interval)} overlap.`,
        });
        continue;
      }

      // No direct overlap, so the conflict is with the reserved cooldown.
      // Distinguished because the fix differs: a cooldown clash is resolved by
      // moving later, not by finding an entirely different slot.
      if (overlaps(firstFootprint, second.interval)) {
        violations.push({
          code: 'cooldown_overlap',
          occurrenceId: second.occurrenceId,
          relatedOccurrenceId: first.occurrenceId,
          interval: second.interval,
          limit: firstFootprint.end,
          message: `Occurrence ${second.occurrenceId} starts at ${second.interval.start}, inside the ${first.cooldownMin}-minute cooldown reserved after ${first.occurrenceId} until ${firstFootprint.end}.`,
        });
      }
    }
  }

  // Sorted once, not once per placement. The order matters only so that two
  // runs report the same violations in the same order (§6.3), and re-deriving
  // it inside the loop made the pass O(placements × blocks log blocks) for a
  // result that cannot change between iterations.
  const blocks = sorted(
    context.fixedBlocks,
    byId((b) => b.id),
  );

  for (const placement of ordered) {
    const reach = footprint(placement);

    for (const block of blocks) {
      const taken = footprint(block);

      if (overlaps(placement.interval, block.interval)) {
        violations.push({
          code: 'fixed_block_overlap',
          occurrenceId: placement.occurrenceId,
          relatedBlockId: block.id,
          interval: placement.interval,
          message: `Occurrence ${placement.occurrenceId} at ${formatInterval(placement.interval)} overlaps fixed block ${block.id} at ${formatInterval(block.interval)}.`,
        });
        continue;
      }

      // The block's own cooldown, which a placement may not start inside
      // (rule 3) — the same reservation a task's makes, in the other
      // direction.
      if (overlaps(placement.interval, taken)) {
        violations.push({
          code: 'cooldown_overlap',
          occurrenceId: placement.occurrenceId,
          relatedBlockId: block.id,
          interval: placement.interval,
          limit: taken.end,
          message: `Occurrence ${placement.occurrenceId} starts at ${placement.interval.start}, inside the ${block.cooldownMin}-minute cooldown reserved after fixed block ${block.id} until ${taken.end}.`,
        });
        continue;
      }

      if (overlaps(reach, block.interval)) {
        violations.push({
          code: 'cooldown_overlap',
          occurrenceId: placement.occurrenceId,
          relatedBlockId: block.id,
          interval: placement.interval,
          limit: reach.end,
          message: `The ${placement.cooldownMin}-minute cooldown after occurrence ${placement.occurrenceId} runs to ${reach.end}, overlapping fixed block ${block.id}.`,
        });
      }
    }
  }
}

/** Rule 4 — a `hard` due date is enforced: placement end ≤ due date. */
function checkDueDates(
  placements: readonly Placement[],
  schedulables: ReadonlyMap<string, Schedulable>,
  violations: Violation[],
): void {
  for (const placement of placements) {
    const schedulable = schedulables.get(placement.occurrenceId)!;
    // Soft due dates are scored, not enforced (spec §6.5); only `hard` invalidates.
    if (schedulable.dueKind !== 'hard' || schedulable.dueDate === undefined) continue;

    if (placement.interval.end > schedulable.dueDate) {
      violations.push({
        code: 'hard_due_date_missed',
        occurrenceId: placement.occurrenceId,
        interval: placement.interval,
        limit: schedulable.dueDate,
        message: `Task ${schedulable.taskId} has a hard due date at ${schedulable.dueDate} but its placement ends at ${placement.interval.end}.`,
      });
    }
  }
}

/** Rule 6 — a manually repositioned task is never placed before its floor. */
function checkManualFloors(
  placements: readonly Placement[],
  schedulables: ReadonlyMap<string, Schedulable>,
  violations: Violation[],
): void {
  for (const placement of placements) {
    const schedulable = schedulables.get(placement.occurrenceId)!;
    if (schedulable.manualFloor === undefined) continue;

    if (placement.interval.start < schedulable.manualFloor) {
      violations.push({
        code: 'manual_floor_violated',
        occurrenceId: placement.occurrenceId,
        interval: placement.interval,
        limit: schedulable.manualFloor,
        message: `Task ${schedulable.taskId} was manually moved to ${schedulable.manualFloor} and may not be placed earlier, but starts at ${placement.interval.start}.`,
      });
    }
  }
}

/**
 * Rule 5 — sequence members are placed contiguously within a single window, in
 * order if ordered, with no foreign task interleaved.
 *
 * "Contiguous" includes the internal cooldowns: M5 collapses a sequence to a
 * composite of summed durations *plus* those cooldowns, so the next member
 * starts exactly where the previous member's footprint ends.
 */
function checkSequences(
  context: ScheduleContext,
  placements: readonly Placement[],
  schedulables: ReadonlyMap<string, Schedulable>,
  violations: Violation[],
): void {
  const placementByOccurrence = new Map(placements.map((p) => [p.occurrenceId, p]));

  // Resolved rather than read straight off the context, so a member referring
  // to an undeclared sequence is still held to rule 5 — see `resolveSequences`.
  for (const sequence of sorted(
    [...resolveSequences(context).values()],
    byId((s) => s.id),
  )) {
    const members = context.schedulables
      .filter((schedulable) => schedulable.sequenceId === sequence.id)
      .map((schedulable) => placementByOccurrence.get(schedulable.occurrenceId))
      .filter((placement): placement is Placement => placement !== undefined);

    // A sequence with fewer than two placed members cannot be discontiguous.
    if (members.length < 2) continue;

    const ordered = sorted(
      members,
      chain(
        byInt((p) => p.interval.start),
        byId((p) => p.occurrenceId),
      ),
    );

    checkSequenceContiguity(sequence.id, ordered, violations);
    if (sequence.isOrdered) {
      checkSequenceOrder(sequence.id, ordered, schedulables, violations);
    }
    checkSequenceWindow(context, sequence.id, ordered, schedulables, violations);
    checkSequenceIsolation(sequence.id, ordered, placements, schedulables, violations);
  }
}

function checkSequenceContiguity(
  sequenceId: string,
  ordered: readonly Placement[],
  violations: Violation[],
): void {
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    const expectedStart = previous.interval.end + previous.cooldownMin;

    if (current.interval.start !== expectedStart) {
      violations.push({
        code: 'sequence_not_contiguous',
        occurrenceId: current.occurrenceId,
        relatedOccurrenceId: previous.occurrenceId,
        sequenceId,
        interval: current.interval,
        limit: expectedStart,
        message: `Sequence ${sequenceId} is uninterruptible, so ${current.occurrenceId} must start at ${expectedStart}, immediately after ${previous.occurrenceId} and its cooldown, but starts at ${current.interval.start}.`,
      });
    }
  }
}

function checkSequenceOrder(
  sequenceId: string,
  ordered: readonly Placement[],
  schedulables: ReadonlyMap<string, Schedulable>,
  violations: Violation[],
): void {
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    const previousPosition = schedulables.get(previous.occurrenceId)?.sequencePosition;
    const currentPosition = schedulables.get(current.occurrenceId)?.sequencePosition;

    if (previousPosition === undefined || currentPosition === undefined) continue;

    if (currentPosition < previousPosition) {
      violations.push({
        code: 'sequence_out_of_order',
        occurrenceId: current.occurrenceId,
        relatedOccurrenceId: previous.occurrenceId,
        sequenceId,
        interval: current.interval,
        message: `Sequence ${sequenceId} is ordered: position ${currentPosition} (${current.occurrenceId}) is placed after position ${previousPosition} (${previous.occurrenceId}).`,
      });
    }
  }
}

function checkSequenceWindow(
  context: ScheduleContext,
  sequenceId: string,
  ordered: readonly Placement[],
  schedulables: ReadonlyMap<string, Schedulable>,
  violations: Violation[],
): void {
  // Every window that could hold each member, intersected across them.
  //
  // Asking whether *some* window holds them all is order-independent, which
  // matters because nothing stops a category having two overlapping
  // availability windows. Resolving each member to "the first window in the
  // array that contains it" would report a split between two members that a
  // third, longer window comfortably contains.
  const perMember = ordered.map((placement) => {
    const schedulable = schedulables.get(placement.occurrenceId)!;
    const candidates = eligibleWindows(
      context.windows,
      schedulable.calendarId,
      schedulable.categoryId,
    );

    return {
      placement,
      windows: candidates.filter(
        (window) =>
          placement.interval.start >= window.interval.start &&
          placement.interval.end <= window.interval.end,
      ),
    };
  });

  // A member in no window at all is rule 1's problem; reporting it again as a
  // span would be noise rather than a second defect.
  if (perMember.some((entry) => entry.windows.length === 0)) return;

  const first = perMember[0]!;
  let common = first.windows;

  for (const entry of perMember.slice(1)) {
    const shared = common.filter((window) =>
      entry.windows.some((candidate) => isSameWindow(candidate, window)),
    );
    if (shared.length > 0) {
      common = shared;
      continue;
    }

    // Reported once, at the member that breaks the run: the fix is the same
    // wherever the block was going to be moved to.
    violations.push({
      code: 'sequence_spans_windows',
      occurrenceId: entry.placement.occurrenceId,
      relatedOccurrenceId: first.placement.occurrenceId,
      sequenceId,
      windowRuleId: entry.windows[0]!.ruleId,
      interval: entry.placement.interval,
      message: `Sequence ${sequenceId} must sit inside a single window, but no availability window contains both ${first.placement.occurrenceId} at ${formatInterval(first.placement.interval)} and ${entry.placement.occurrenceId} at ${formatInterval(entry.placement.interval)}.`,
    });
    return;
  }
}

/** Resolved windows have no identity of their own; a rule plus its span is one. */
function isSameWindow(a: ResolvedWindow, b: ResolvedWindow): boolean {
  return (
    a.ruleId === b.ruleId &&
    a.interval.start === b.interval.start &&
    a.interval.end === b.interval.end
  );
}

function checkSequenceIsolation(
  sequenceId: string,
  ordered: readonly Placement[],
  allPlacements: readonly Placement[],
  schedulables: ReadonlyMap<string, Schedulable>,
  violations: Violation[],
): void {
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const span: Interval = {
    start: first.interval.start,
    // The trailing cooldown belongs to the block; a task placed inside it is
    // interleaved just as surely as one between two members.
    end: last.interval.end + last.cooldownMin,
  };

  const memberOccurrences = new Set(ordered.map((placement) => placement.occurrenceId));

  for (const placement of sorted(
    allPlacements,
    byId((p) => p.occurrenceId),
  )) {
    if (memberOccurrences.has(placement.occurrenceId)) continue;
    if (!overlaps(placement.interval, span)) continue;

    const schedulable = schedulables.get(placement.occurrenceId);
    violations.push({
      code: 'sequence_interleaved',
      occurrenceId: placement.occurrenceId,
      sequenceId,
      interval: placement.interval,
      message: `Task ${schedulable?.taskId ?? placement.occurrenceId} is placed at ${formatInterval(placement.interval)}, inside the uninterruptible span ${formatInterval(span)} of sequence ${sequenceId}.`,
    });
  }
}
