import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Enumerations shared across the scheduling tables, declared together so the
 * vocabulary of the domain is readable in one place.
 */

/** Spec §4.3 / §10.2. Governs what detail other users may see. */
export const visibilityScope = pgEnum('visibility_scope', ['private', 'team', 'group']);

/** Spec §9.1. Two windows per calendar, same per-weekday shape. */
export const calendarWindowKind = pgEnum('calendar_window_kind', ['working', 'shareable']);

/** Spec §4.4. `hard` is validator-enforced (§6.2); `soft` only warns (§6.5). */
export const dueKind = pgEnum('due_kind', ['soft', 'hard']);

/** Spec §4.4. */
export const taskStatus = pgEnum('task_status', ['active', 'completed', 'cancelled']);

/** Spec §8.2. A recurring task is a demand rule, not a datetime rule. */
export const recurrencePeriod = pgEnum('recurrence_period', ['day', 'week', 'month']);

/**
 * Spec §8.2. What happens to a period's occurrence that was never completed:
 * carry the debt forward, or drop it.
 */
export const missedOccurrencePolicy = pgEnum('missed_occurrence_policy', ['rollover', 'expire']);

/** Lifecycle of a single period's demand instance (spec §8.2). */
export const occurrenceStatus = pgEnum('occurrence_status', [
  'pending',
  'completed',
  'expired',
  'cancelled',
]);

/** Spec §4.5. The appointment itself, distinct from per-participant status. */
export const appointmentStatus = pgEnum('appointment_status', [
  'confirmed',
  'tentative',
  'cancelled',
]);

/** Spec §4.3. Present now so internal-appointment negotiation is additive later. */
export const participantStatus = pgEnum('participant_status', [
  'proposed',
  'confirmed',
  'change_requested',
]);

/** Spec §11. */
export const notificationType = pgEnum('notification_type', [
  'backlog_added',
  'due_date_at_risk',
  'hard_constraint_conflict',
  'chronic_postponement',
  'internal_appointment_change',
  'working_window_divergence',
]);

/** Spec §6.5 / §6.7: soft due dates warn, hard ones alert. */
export const notificationSeverity = pgEnum('notification_severity', ['info', 'warning', 'alert']);
