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
  /** Rule 1: placed outside any availability window of its activity type. */
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

/**
 * Why a task could not be placed in the hard horizon (spec §6.7). The engine
 * names the reason rather than reporting a bare failure, because the fixes
 * differ: no window at all is a configuration problem, a full activity type is a
 * capacity problem, an unreachable deadline is a planning problem.
 */
export type InfeasibilityReason =
  /** The task's activity type has no availability window in the horizon. */
  | 'no_feasible_window'
  /** Windows exist, but every slot is taken by other tasks or fixed blocks. */
  | 'insufficient_remaining_capacity'
  /** A hard due date falls before any slot the task could occupy. */
  | 'hard_due_date_unreachable'
  /** A manual floor pushes the task past the end of the horizon. */
  | 'manual_floor_beyond_horizon'
  /**
   * A sequence needs one unbroken span and no window offers one long enough
   * (spec §6.6, §6.7). Distinct from insufficient capacity: the activity type may
   * hold plenty of minutes, just never enough of them in a row.
   */
  | 'no_contiguous_span'
  /**
   * A sequence's members cannot share a window — they belong to different
   * activity types or calendars. A data problem, not a capacity one.
   */
  | 'sequence_members_incompatible';

/**
 * A non-fatal signal about the schedule (spec §6.7, §11).
 *
 * Distinct from `Violation`: a violation means the schedule is *invalid*, while
 * a diagnostic reports something the user should know about a schedule that is
 * otherwise perfectly legal — a task pushed to the backlog, a soft due date at
 * risk.
 */
export type DiagnosticCode =
  /** Moved to the backlog with an estimated week. Informational (§11). */
  | 'backlogged'
  /** A soft due date will be missed. Warning (§6.5). */
  | 'soft_due_date_at_risk'
  /** A hard due date cannot be met. Alert (§6.7). */
  | 'hard_due_date_at_risk';

/** Mirrors the notification severities of spec §11. */
export type DiagnosticSeverity = 'info' | 'warning' | 'alert';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  occurrenceId: string;
  taskId: string;
  message: string;
  /**
   * Set when the occurrence belongs to a sequence, so a caller can group the
   * members' diagnostics into the one thing the user actually sees.
   */
  sequenceId?: string;
  /** Present when the diagnostic explains why placement failed. */
  reason?: InfeasibilityReason;
  /** The week the coarse planner assigned, formatted `YYYY-MM-DD`. */
  estimatedWeek?: string;
  /** The due date at risk, when there is one. */
  dueDate?: Instant;
}
