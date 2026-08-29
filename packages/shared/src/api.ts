import { z } from 'zod';
import {
  addAppointmentParams,
  addUnavailabilityParams,
  cancelTaskParams,
  clearWeekParams,
  completeTaskParams,
  createTaskParams,
  deferTaskParams,
  editAppointmentParams,
  editTaskParams,
  extendTaskParams,
  moveTaskParams,
  moveToBacklogParams,
  postponeRestOfDayParams,
  promoteFromBacklogParams,
  redoParams,
  swapForwardParams,
  swapTasksParams,
  undoParams,
} from './commands.js';

/**
 * The HTTP contract, defined once and imported by both sides (spec §3.1).
 *
 * Two things are deliberately *not* in the request envelope, and both are the
 * same decision: **the server owns identity and time.**
 *
 * `actor` and `tenant_id` come from the session (§10.1), never from the body.
 * A client that could name its own tenant would make every endpoint responsible
 * for re-deciding whether it was allowed to.
 *
 * `issued_at` is stamped on arrival. M6 made it the `now` the schedule derives
 * against, which makes a replay reproducible — and makes a client-supplied
 * value a way to schedule against a clock of one's choosing. A command queued
 * offline (§2.1) therefore derives against the moment it is *applied*, which is
 * the only honest answer: the world moved on while it was queued.
 *
 * `id` **is** the client's to send, and should be. It is the log's primary key
 * (§7.1), so a retry of a request whose response was lost is refused rather
 * than applied twice.
 */

const uuid = z.uuid();
/** ISO-8601 with an explicit offset. The API speaks instants, not minutes. */
const instant = z.iso.datetime({ offset: true });
const civilDate = z.iso.date();

/** What a caller may put in the envelope; the rest the server fills in. */
const requestEnvelope = {
  /** Client-generated UUID v7. Omit it and the server mints one. */
  id: uuid.optional(),
  /** Ties commands into one atomic unit for undo (§7.5). */
  groupId: uuid.optional(),
  expectedVersion: z.int().positive().optional(),
} as const;

function request<T extends string, P extends z.ZodType>(type: T, params: P) {
  return z.object({ ...requestEnvelope, type: z.literal(type), params });
}

/**
 * The body of `POST /api/commands`.
 *
 * Deliberately a second union rather than `commandSchema` with fields made
 * optional: a field that may be sent and is then ignored is worse than one that
 * is refused, because the caller believes it took effect. `commandRequestCovers`
 * in the test suite holds the two unions to the same vocabulary.
 */
export const commandRequestSchema = z.discriminatedUnion('type', [
  request('CreateTask', createTaskParams),
  request('EditTask', editTaskParams),
  request('AddAppointment', addAppointmentParams),
  request('EditAppointment', editAppointmentParams),
  request('MoveTask', moveTaskParams),
  request('DeferTask', deferTaskParams),
  request('CompleteTask', completeTaskParams),
  request('PostponeRestOfDay', postponeRestOfDayParams),
  request('ClearWeek', clearWeekParams),
  request('ExtendTask', extendTaskParams),
  request('CancelTask', cancelTaskParams),
  request('SwapTasks', swapTasksParams),
  request('SwapForward', swapForwardParams),
  request('PromoteFromBacklog', promoteFromBacklogParams),
  request('MoveToBacklog', moveToBacklogParams),
  request('AddUnavailability', addUnavailabilityParams),
  request('Undo', undoParams),
  request('Redo', redoParams),
]);

export type CommandRequest = z.infer<typeof commandRequestSchema>;

/* -------------------------------------------------------------------------
 * Read models
 * ---------------------------------------------------------------------- */

/**
 * A placement, enriched with what a calendar grid needs to draw it.
 *
 * The engine's own `Placement` carries an occurrence id and an interval and
 * nothing else, which is right for a solver and useless for rendering. The
 * join happens once, server-side, rather than in every consumer.
 */
export const scheduledBlockSchema = z.object({
  occurrenceId: uuid,
  taskId: uuid,
  title: z.string(),
  categoryId: uuid.nullable(),
  start: instant,
  end: instant,
  /** Non-compressible gap reserved after the block (§6.2 rule 3). */
  cooldownMin: z.int().nonnegative(),
});

export const fixedBlockSchema = z.object({
  appointmentId: uuid,
  title: z.string(),
  start: instant,
  end: instant,
  isUnavailability: z.boolean(),
  isInternal: z.boolean(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
});

export const backlogEntrySchema = z.object({
  occurrenceId: uuid,
  taskId: uuid,
  title: z.string(),
  /** Week start `YYYY-MM-DD`, or null when no week can honestly be named. */
  estimatedWeek: civilDate.nullable(),
  reason: z.string(),
  sequenceId: uuid.nullable(),
});

export const diagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  occurrenceId: uuid,
  taskId: uuid,
  message: z.string(),
  reason: z.string().optional(),
  sequenceId: uuid.optional(),
  estimatedWeek: civilDate.optional(),
  dueDate: instant.optional(),
});

export const capacityCellSchema = z.object({
  calendarId: uuid,
  categoryId: uuid,
  weekStart: civilDate,
  supplyMin: z.int().nonnegative(),
  demandMin: z.int().nonnegative(),
  /** `demand / supply` as a plain ratio, or null when there is no supply. */
  utilization: z.number().nullable(),
  status: z.enum(['comfortable', 'tight', 'overcommitted']),
  maxContiguousSpanMin: z.int().nonnegative(),
  longestSequenceMin: z.int().nonnegative(),
  hasContiguousSpan: z.boolean(),
  reservedCooldownMin: z.int().nonnegative(),
});

/**
 * A task the solver was never offered, and why (§6.7).
 *
 * Distinct from a diagnostic: a diagnostic explains a scheduling outcome, this
 * explains an absence. A task with no category or no estimate is not competing
 * for time badly — it is not competing at all, and the fix is data entry.
 */
export const unschedulableSchema = z.object({
  taskId: uuid,
  occurrenceId: uuid,
  reason: z.enum(['no_category', 'no_duration']),
});

export const scheduleSchema = z.object({
  calendarId: uuid,
  /** The hard horizon actually used (§6.1), so a client can render its edge. */
  horizon: z.object({ start: instant, end: instant }),
  blocks: z.array(scheduledBlockSchema),
  backlog: z.array(backlogEntrySchema),
  diagnostics: z.array(diagnosticSchema),
  unschedulable: z.array(unschedulableSchema),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export const calendarSummarySchema = z.object({
  id: uuid,
  name: z.string(),
  timezone: z.string(),
});

export const calendarListSchema = z.object({ calendars: z.array(calendarSummarySchema) });

export const scheduleResponseSchema = z.object({
  schedule: scheduleSchema,
  /** Appointments and unavailability in the same window, for the same grid. */
  fixedBlocks: z.array(fixedBlockSchema),
});

export const backlogResponseSchema = z.object({
  calendarId: uuid,
  entries: z.array(backlogEntrySchema),
});

export const capacityResponseSchema = z.object({
  calendarId: uuid,
  cells: z.array(capacityCellSchema),
});

export const notificationSchema = z.object({
  id: uuid,
  type: z.string(),
  severity: z.string(),
  payload: z.unknown(),
  readAt: instant.nullable(),
  createdAt: instant,
});

export const notificationListSchema = z.object({
  notifications: z.array(notificationSchema),
});

/* -------------------------------------------------------------------------
 * Command result and errors
 * ---------------------------------------------------------------------- */

export const attentionItemSchema = z.object({
  kind: z.literal('appointment_needs_rescheduling'),
  appointmentId: uuid,
  title: z.string(),
  isInternal: z.boolean(),
});

export const commandResultSchema = z.object({
  commandId: uuid,
  /**
   * The log's total order (§12). A string because it is a Postgres `bigserial`
   * and JSON has no integer wide enough to promise it back unchanged.
   */
  seq: z.string(),
  /** One per calendar the command touched, freshly derived. */
  schedules: z.array(scheduleSchema),
  /** What the command deliberately left for a person to deal with (§7.2). */
  attention: z.array(attentionItemSchema),
});

export type CommandResult = z.infer<typeof commandResultSchema>;

/**
 * Every way a request can fail, named.
 *
 * The codes are the API's vocabulary, not HTTP's: a client deciding what to do
 * about a version conflict should not be pattern-matching on 409.
 */
export const API_ERROR_CODES = [
  'invalid_command',
  'invalid_request',
  'not_found',
  'version_conflict',
  'precondition_failed',
  'unauthenticated',
  /** The write would have left the schedule violating §6.2. See the commit hook. */
  'invariant_violated',
  'internal',
] as const;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** Field-level detail from a Zod failure. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    expectedVersion: z.int().optional(),
    actualVersion: z.int().optional(),
  }),
});

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
