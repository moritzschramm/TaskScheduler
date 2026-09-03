import { z } from 'zod';
import {
  addAppointmentParams,
  addUnavailabilityParams,
  cancelTaskParams,
  clearFloorParams,
  clearWeekParams,
  completeTaskParams,
  configureCalendarParams,
  createCalendarParams,
  createCategoryParams,
  createTaskParams,
  createWeekTypeOverrideParams,
  deferTaskParams,
  deleteCategoryParams,
  deleteWeekTypeOverrideParams,
  editAppointmentParams,
  editCategoryParams,
  editTaskParams,
  editWeekTypeOverrideParams,
  extendTaskParams,
  markNotificationsReadParams,
  updateSettingsParams,
  moveTaskParams,
  moveToBacklogParams,
  postponeRestOfDayParams,
  blockOutDayParams,
  promoteFromBacklogParams,
  redoParams,
  setAvailabilityWindowsParams,
  setCalendarWindowsParams,
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
  request('ClearFloor', clearFloorParams),
  request('DeferTask', deferTaskParams),
  request('CompleteTask', completeTaskParams),
  request('PostponeRestOfDay', postponeRestOfDayParams),
  request('BlockOutDay', blockOutDayParams),
  request('ClearWeek', clearWeekParams),
  request('ExtendTask', extendTaskParams),
  request('CancelTask', cancelTaskParams),
  request('SwapTasks', swapTasksParams),
  request('SwapForward', swapForwardParams),
  request('PromoteFromBacklog', promoteFromBacklogParams),
  request('MoveToBacklog', moveToBacklogParams),
  request('AddUnavailability', addUnavailabilityParams),
  request('MarkNotificationsRead', markNotificationsReadParams),
  request('UpdateSettings', updateSettingsParams),
  request('CreateCalendar', createCalendarParams),
  request('ConfigureCalendar', configureCalendarParams),
  request('SetCalendarWindows', setCalendarWindowsParams),
  request('CreateCategory', createCategoryParams),
  request('EditCategory', editCategoryParams),
  request('DeleteCategory', deleteCategoryParams),
  request('SetAvailabilityWindows', setAvailabilityWindowsParams),
  request('CreateWeekTypeOverride', createWeekTypeOverrideParams),
  request('EditWeekTypeOverride', editWeekTypeOverrideParams),
  request('DeleteWeekTypeOverride', deleteWeekTypeOverrideParams),
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
  notes: z.string().nullable(),
  start: instant,
  end: instant,
  /** The optimistic lock an editor sends back with its patch (spec §5.4). */
  version: z.int().positive(),
  /**
   * Set when this block is one instance of a recurring series (§8.1).
   *
   * An expanded instance is not a row, so an editor needs to know which
   * instance of which template it is looking at before it can offer "this
   * occurrence" or "this and all future".
   */
  occurrenceStart: instant.nullable(),
  isRecurring: z.boolean(),
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
  /** §6.5's own scale: warning versus alert is the soft/hard due-date split. */
  severity: z.enum(['info', 'warning', 'alert']),
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

/**
 * Configuration — what a settings screen reads before it can offer an edit
 * (spec §4.3, §9.1).
 *
 * One response rather than five endpoints because the pieces are only
 * meaningful together: an availability window names a category and a week-type
 * override, and a screen that fetched them separately would render ids until
 * the last request landed.
 *
 * The whole document is the tenant's configuration as it bears on **one**
 * calendar. Categories are tenant-scoped and so appear whole; windows and
 * overrides are per-calendar and are filtered to this one.
 */
export const weekdayRuleSchema = z.object({
  /** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
  weekday: z.int().min(1).max(7),
  /** Minutes since local midnight, in the calendar's zone. */
  startMin: z.int().min(0).max(1440),
  endMin: z.int().min(0).max(1440),
});

export const calendarWindowSchema = weekdayRuleSchema.extend({
  id: uuid,
  kind: z.enum(['working', 'shareable']),
});

export const availabilityWindowSchema = weekdayRuleSchema.extend({
  id: uuid,
  categoryId: uuid,
  /** `null` = part of the default set; set = part of that override's set. */
  weekTypeOverrideId: uuid.nullable(),
  focusLevel: z.int().min(1).max(5).nullable(),
});

export const categorySchema = z.object({
  id: uuid,
  name: z.string(),
  defaultCooldownMin: z.int().nonnegative(),
  version: z.int().positive(),
});

export const weekTypeOverrideSchema = z.object({
  id: uuid,
  name: z.string(),
  /** Half-open `[startDate, endDate)`, like every other interval (§5.1). */
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  version: z.int().positive(),
});

export const calendarConfigurationSchema = z.object({
  calendar: calendarSummarySchema.extend({
    visibilityScope: z.enum(['private', 'team', 'group']),
    /** The optimistic lock a settings form sends back with its edit (§5.4). */
    version: z.int().positive(),
    isOwner: z.boolean(),
  }),
  /** Both of §9.1's windows, distinguished by `kind`. */
  windows: z.array(calendarWindowSchema),
  categories: z.array(categorySchema),
  availability: z.array(availabilityWindowSchema),
  weekTypeOverrides: z.array(weekTypeOverrideSchema),
});

export type WeekdayRule = z.infer<typeof weekdayRuleSchema>;
export type CalendarWindow = z.infer<typeof calendarWindowSchema>;
export type AvailabilityWindow = z.infer<typeof availabilityWindowSchema>;
export type Category = z.infer<typeof categorySchema>;
export type WeekTypeOverrideEntry = z.infer<typeof weekTypeOverrideSchema>;
export type CalendarConfiguration = z.infer<typeof calendarConfigurationSchema>;

/**
 * A task that was completed where it stood (spec §3.4, §7.3).
 *
 * **Not part of `Schedule`.** The engine's answer is what it would place *now*,
 * and a completed occurrence is not demand any more — putting these in
 * `schedule.blocks` would make the client's optimistic solve disagree with the
 * server on every read, because the engine cannot produce them and never will.
 * They ride alongside, like the fixed blocks, and only the grid reads them.
 */
export const completedBlockSchema = z.object({
  occurrenceId: uuid,
  taskId: uuid,
  title: z.string(),
  categoryId: uuid.nullable(),
  /** Where it sat when it was finished — half-open, like every interval. */
  start: instant,
  end: instant,
  completedAt: instant,
});

export type CompletedBlock = z.infer<typeof completedBlockSchema>;

export const scheduleResponseSchema = z.object({
  schedule: scheduleSchema,
  /** Appointments and unavailability in the same window, for the same grid. */
  fixedBlocks: z.array(fixedBlockSchema),
  /** What was done, still drawn where it was done. */
  completedBlocks: z.array(completedBlockSchema),
  /**
   * Utilization per (category, week), from the very same solve (§6.6).
   *
   * Carried here rather than fetched beside it. Capacity is a reading *of* a
   * schedule — supply against the demand that was placed in it — so computing
   * it needs the derived result and nothing else. Asking for it separately
   * meant a second full solve of the same calendar at a slightly later `now`,
   * which is both wasted work and a way for the indicator to disagree with the
   * grid it sits under.
   */
  capacity: z.array(capacityCellSchema),
});

export const backlogResponseSchema = z.object({
  calendarId: uuid,
  entries: z.array(backlogEntrySchema),
});

export const capacityResponseSchema = z.object({
  calendarId: uuid,
  cells: z.array(capacityCellSchema),
});

/**
 * A task as the task panel sees it (spec §4.4).
 *
 * Carries **both** the value a task sets itself and the value it ends up with,
 * because the difference is the whole of §4.4's inheritance and a panel that
 * showed only one of them could not say whether a property was chosen here or
 * came from an ancestor. M11's override affordance needs exactly this pair.
 */
export const taskNodeSchema = z.object({
  id: uuid,
  parentId: uuid.nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  depth: z.int().min(1).max(5),
  /** Ancestor ids from the root down to and including this task. */
  path: z.array(uuid),
  /** Only leaves are placed; a parent rolls up from its children (§4.4). */
  isLeaf: z.boolean(),
  status: z.enum(['active', 'completed', 'cancelled']),
  /** The optimistic lock an editor sends back with its patch (spec §5.4). */
  version: z.int().positive(),
  estimatedDurationMin: z.int().nullable(),
  ownCategoryId: uuid.nullable(),
  effectiveCategoryId: uuid.nullable(),
  ownPriority: z.int().nullable(),
  effectivePriority: z.int().nullable(),
  ownDueDate: instant.nullable(),
  effectiveDueDate: instant.nullable(),
  ownDueKind: z.enum(['soft', 'hard']).nullable(),
  effectiveDueKind: z.enum(['soft', 'hard']).nullable(),
  /** Minutes since local midnight; the pair travels together or not at all. */
  ownPreferredStartMin: z.int().min(0).max(1440).nullable(),
  effectivePreferredStartMin: z.int().min(0).max(1440).nullable(),
  ownPreferredEndMin: z.int().min(0).max(1440).nullable(),
  effectivePreferredEndMin: z.int().min(0).max(1440).nullable(),
  ownFocusLevel: z.int().nullable(),
  effectiveFocusLevel: z.int().nullable(),
  ownCooldownOverrideMin: z.int().nullable(),
  effectiveCooldownOverrideMin: z.int().nullable(),
  /**
   * The soft not-before a manual reposition left behind (§7.3).
   *
   * Read models mostly carry what a task *is*; this one carries something that
   * was done to it, because a floor is invisible in the schedule — a task
   * sitting at 14:00 looks the same whether it chose to or was told to — and a
   * user cannot reset what they cannot see.
   */
  manualFloor: instant.nullable(),
  manualBias: instant.nullable(),
  /** The demand rule of §8.2, or `null`. Not inheritable — see `EditTask`. */
  recurrence: z
    .object({
      period: z.enum(['day', 'week', 'month']),
      count: z.int().min(1),
      missedPolicy: z.enum(['rollover', 'expire']),
    })
    .nullable(),
});

export const taskListSchema = z.object({
  calendarId: uuid,
  tasks: z.array(taskNodeSchema),
});

/**
 * What the undo and redo controls need (spec §7.5, §12).
 *
 * The command types rather than prose: a label is a translation decision, and
 * the vocabulary here is the same one the log records and a future parser
 * emits. One entry per *unit* of history, since a group of commands is undone
 * whole or not at all.
 */
export const historySchema = z.object({
  /** The command types of the next unit `Undo` would reverse, or `null`. */
  undoable: z.array(z.string()).nullable(),
  /** The same for `Redo`. */
  redoable: z.array(z.string()).nullable(),
  /**
   * The window filled up, so an empty `undoable` means "no further back than
   * this" rather than "nothing was ever done".
   */
  truncated: z.boolean(),
});

export type HistoryView = z.infer<typeof historySchema>;

/**
 * The audit view over the command log (spec §12).
 *
 * "One append-only command log serves all three: undo/redo, history, and
 * audit — the same log, with configurable retention."
 *
 * So this is a read, not a second store. Every entry is a command somebody
 * issued, in the order the database gave it: `seq` is a `bigserial` and is the
 * only strict total order the log has, which is why it is the cursor rather
 * than a timestamp two commands can share.
 *
 * `changed` counts rows rather than listing them. The before/after images are
 * what undo runs on (§12) and can be large; an audit view answers "who did
 * what, when, and how much did it touch", and a caller wanting the rest has
 * the command id.
 */
export const auditEntrySchema = z.object({
  id: uuid,
  /** The log's strict total order, as a string — `bigserial` outruns JSON. */
  seq: z.string(),
  type: z.string(),
  actorId: uuid,
  actorEmail: z.string().nullable(),
  /** What the command was asked to do. Parameters, not row images. */
  params: z.unknown(),
  groupId: uuid.nullable(),
  /**
   * How many tasks it wrote or moved.
   *
   * `null` on entries recorded before the log carried it — unknown, which a
   * reader must not render as none. The number a row count would have given is
   * not a substitute: a command that writes one appointment can move a dozen
   * tasks, and it is the dozen somebody is looking for.
   */
  affectedTasks: z.int().nonnegative().nullable(),
  /** Which calendars it re-derived, if any. */
  calendarIds: z.array(uuid),
  issuedAt: instant,
});

export const auditResponseSchema = z.object({
  entries: z.array(auditEntrySchema),
  /** Pass as `before` to fetch the page after this one; `null` at the end. */
  nextCursor: z.string().nullable(),
  /** How long entries are kept, in days. `null` means for ever (§12). */
  retentionDays: z.int().positive().nullable(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AuditResponse = z.infer<typeof auditResponseSchema>;

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

/**
 * Something the command brought into existence.
 *
 * Ids are minted by Postgres (`uuidv7()`, §5.1), so a client that has just
 * created a category cannot know its id — and it needs one immediately, to hang
 * availability windows off. Re-reading and matching on the name would be a
 * guess: two categories can be renamed into and out of each other between two
 * requests, and the client would attach windows to the wrong one.
 *
 * `entity` is the API's vocabulary rather than the schema's table names, for
 * the same reason the error codes are (below).
 */
export const createdEntitySchema = z.object({
  entity: z.enum([
    'task',
    'occurrence',
    'appointment',
    'calendar',
    'calendar_window',
    'category',
    'availability_window',
    'week_type_override',
    'notification',
    'user',
  ]),
  id: uuid,
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
  /** In the order the command created them. */
  created: z.array(createdEntitySchema),
  /** What the command deliberately left for a person to deal with (§7.2). */
  attention: z.array(attentionItemSchema),
});

export type CreatedEntity = z.infer<typeof createdEntitySchema>;

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
  /** §14's rate limit; the response carries `Retry-After`. */
  'rate_limited',
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

export type ScheduledBlock = z.infer<typeof scheduledBlockSchema>;
export type BacklogEntry = z.infer<typeof backlogEntrySchema>;
export type CapacityCell = z.infer<typeof capacityCellSchema>;
export type FixedBlock = z.infer<typeof fixedBlockSchema>;
export type CalendarSummary = z.infer<typeof calendarSummarySchema>;
export type Notification = z.infer<typeof notificationSchema>;

export type TaskNode = z.infer<typeof taskNodeSchema>;
