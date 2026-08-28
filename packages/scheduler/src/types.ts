import type { CivilDate, Instant, Interval, MinuteOfDay } from './time.js';

/**
 * The scheduler's input and output types.
 *
 * All plain data: no class instances, no database rows, no dates. The engine is
 * a pure function of these values (spec §3.3), which is what lets the identical
 * module run on the client for an optimistic schedule and on the server for the
 * authoritative one.
 *
 * Callers are expected to have already resolved inheritance (spec §4.4) — the
 * values here are *effective* values, not the nullable columns they came from.
 */

export type DueKind = 'soft' | 'hard';

/**
 * One unit of demand to be placed.
 *
 * Keyed by occurrence, not task: every schedulable task has at least one
 * occurrence, and recurring tasks have one per period, so the engine has a
 * single uniform unit to reason about.
 */
export interface Schedulable {
  occurrenceId: string;
  taskId: string;
  calendarId: string;
  categoryId: string;

  /** Integer minutes. Must be positive to be placeable. */
  durationMin: number;
  /**
   * Non-compressible gap reserved *after* the task (spec §6.2 rule 3), already
   * resolved from the task override or the category default.
   */
  cooldownMin: number;

  dueDate?: Instant;
  dueKind?: DueKind;

  /** Soft not-before from a manual reposition (spec §7.3). */
  manualFloor?: Instant;
  /** Preferred datetime from that same reposition. A bias, not a pin. */
  manualBias?: Instant;

  sequenceId?: string;
  /** Only meaningful when the sequence is ordered. */
  sequencePosition?: number;

  /** Soft. Higher is more urgent; the scale is a tuning value (spec §15). */
  priority?: number;
  /** Soft preference, in minutes since local midnight. */
  preferredRange?: { startMin: MinuteOfDay; endMin: MinuteOfDay };
  /** Soft. 1 (shallow) … 5 (deep), matched against a window's profile. */
  focusLevel?: number;
}

/**
 * An immovable block: an appointment, or a content-free unavailability (spec
 * §7.4). The engine does not distinguish them — both are simply time that is
 * already taken.
 */
export interface FixedBlock {
  id: string;
  calendarId: string;
  interval: Interval;
}

/** A recurring per-weekday availability rule, before expansion. */
export interface AvailabilityRule {
  id: string;
  calendarId: string;
  categoryId: string;
  /** NULL/absent = part of the default set; set = part of that override's set. */
  weekTypeOverrideId?: string;
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  weekday: number;
  startMin: MinuteOfDay;
  endMin: MinuteOfDay;
  focusLevel?: number;
}

/** A date range whose rules replace the default set entirely (spec §4.3). */
export interface WeekTypeOverride {
  id: string;
  calendarId: string;
  /** Half-open `[startDate, endDate)`, in the calendar's local dates. */
  startDate: CivilDate;
  endDate: CivilDate;
}

/** A concrete window instance, expanded from a rule onto a specific date. */
export interface ResolvedWindow {
  /** The rule this came from; several resolved windows share one rule id. */
  ruleId: string;
  calendarId: string;
  categoryId: string;
  interval: Interval;
  focusLevel?: number;
}

/** An uninterruptible block grouping member tasks (spec §6.4). */
export interface SequenceSpec {
  id: string;
  /** When true, members must be placed in `sequencePosition` order. */
  isOrdered: boolean;
}

/** A calendar's scheduling context: its zone, needed to expand wall-clock rules. */
export interface CalendarSpec {
  id: string;
  /** IANA zone name. Wall-clock rules are resolved against it (spec §5.1). */
  timeZone: string;
}

/** A concrete assignment of an occurrence to a time (spec §3.4). */
export interface Placement {
  occurrenceId: string;
  interval: Interval;
  /** Reserved after `interval`; part of the footprint for overlap purposes. */
  cooldownMin: number;
}

/**
 * Everything the engine needs to validate or produce a schedule.
 *
 * `now` is explicit and the horizon is bounded — no part of the engine reads a
 * clock (spec §6.3).
 */
export interface ScheduleContext {
  now: Instant;
  horizon: Interval;
  calendars: CalendarSpec[];
  schedulables: Schedulable[];
  fixedBlocks: FixedBlock[];
  windows: ResolvedWindow[];
  sequences: SequenceSpec[];
}
