import type { Instant, Interval } from './time.js';

/**
 * Every way a schedule can violate a hard constraint (spec §6.2).
 *
 * Rule 5 ("sequence contiguity") gets four codes rather than one because its
 * failure modes call for different fixes: a gap between members, a wrong order,
 * a split across windows and a foreign task wedged in the middle are not the
 * same problem, and a diagnostic that cannot tell them apart is not actionable.
 *
 * Spec §6.2 rule 7 (depth ≤ 5, child due ≤ parent due) is absent on purpose: it
 * is a data constraint enforced in the database (M2), not a property of a
 * proposed schedule.
 */
export type ViolationCode =
  /** Rule 1: placed outside any availability window of its category. */
  | 'outside_availability_window'
  /** Rule 2: two placements overlap. */
  | 'placement_overlap'
  /** Rule 2: a placement overlaps a fixed block. */
  | 'fixed_block_overlap'
  /** Rule 3: a placement intrudes on another's non-compressible cooldown. */
  | 'cooldown_overlap'
  /** Rule 4: placement ends after a hard due date. */
  | 'hard_due_date_missed'
  /** Rule 5: sequence members are not back-to-back. */
  | 'sequence_not_contiguous'
  /** Rule 5: ordered sequence members are placed out of order. */
  | 'sequence_out_of_order'
  /** Rule 5: sequence members are split across different windows. */
  | 'sequence_spans_windows'
  /** Rule 5: a task outside the sequence is placed inside its span. */
  | 'sequence_interleaved'
  /** Rule 6: placed before a manual floor. */
  | 'manual_floor_violated'
  /** A placement references an occurrence the context does not contain. */
  | 'unknown_occurrence'
  /** Two placements for the same occurrence. */
  | 'duplicate_placement';

/**
 * A single hard-constraint violation.
 *
 * Carries the ids involved and the times that conflict, so a caller can point
 * at the problem without re-deriving it — the surfacing in M13 renders these
 * directly.
 */
export interface Violation {
  code: ViolationCode;
  /** Human-readable, and specific: names the entities and the times involved. */
  message: string;
  /** The occurrence whose placement is at fault. */
  occurrenceId: string;
  /** The other party, when the violation is between two things. */
  relatedOccurrenceId?: string;
  relatedBlockId?: string;
  sequenceId?: string;
  windowRuleId?: string;
  /** The placement interval that failed. */
  interval?: Interval;
  /** The instant the rule turns on: a due date, a manual floor, a window edge. */
  limit?: Instant;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}
