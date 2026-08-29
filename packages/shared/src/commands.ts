import { z } from 'zod';
import { uuidv7 } from './uuid.js';

/**
 * Commands — the single write path (spec §3.2, §7).
 *
 * A command is a **named, parameterized, serializable intent object**. Nothing
 * else may mutate source state, which is what makes derived scheduling, undo,
 * audit and a future natural-language interface one mechanism instead of four.
 *
 * The schemas live here, in the shared package, because the GUI emits commands
 * and the server applies them: one definition, so a client cannot construct
 * something the server would have to reject on shape (global conventions).
 *
 * **Naming.** Where the spec names a command it is used verbatim —
 * `AddAppointment`, `MoveTask`, `DeferTask`, `CompleteTask`,
 * `PostponeRestOfDay`, `ClearWeek` — because that vocabulary is also the future
 * parser's target. `CreateTask`, `EditTask` and `EditAppointment` are not named
 * in §7 and follow the obvious convention.
 *
 * `Undo` and `Redo` are commands like any other (§7.5): they are appended to
 * the log alongside what they reversed, so the history stays an honest record
 * of intent — including the intent to take something back.
 */

const uuid = z.uuid();
/** An instant, ISO-8601 with an explicit offset (spec §5.1). */
const instant = z.iso.datetime({ offset: true });
/** A local calendar date, `YYYY-MM-DD` — a wall-clock day, not an instant. */
const civilDate = z.iso.date();
/** Minutes since local midnight, half-open `[0, 1440]`. */
const minuteOfDay = z.int().min(0).max(1440);

/**
 * A due date and its enforcement travel together, and a preferred range travels
 * as a pair, because half of either is meaningless: a `due_kind` with no date
 * says nothing, a date with no kind is ambiguous between warning and enforcing,
 * and one end of a range is not a range. The database says the same thing with
 * the `tasks_due_pair` and `tasks_preferred_range_valid` check constraints;
 * grouping them here means a command cannot even express the broken state.
 */
const dueDate = z.object({ date: instant, kind: z.enum(['soft', 'hard']) });

const preferredRange = z
  .object({ startMin: minuteOfDay, endMin: minuteOfDay })
  .refine((range) => range.startMin < range.endMin, {
    message: 'preferredRange.startMin must be before endMin',
  });

/** The inheritable properties of spec §4.4 a command may set on a task. */
const taskAttributes = {
  categoryId: uuid,
  estimatedDurationMin: z.int().positive(),
  priority: z.int(),
  dueDate,
  preferredRange,
  /** 1 (shallow) … 5 (deep), matched against a window's focus profile (§6.5). */
  focusLevel: z.int().min(1).max(5),
  cooldownOverrideMin: z.int().nonnegative(),
} as const;

const createTaskParams = z.object({
  calendarId: uuid,
  title: z.string().min(1),
  notes: z.string().optional(),
  /** Adjacency list; absent for a root task. Depth is capped at 5 (§4.4). */
  parentId: uuid.optional(),
  sequenceId: uuid.optional(),
  sequencePosition: z.int().optional(),
  categoryId: taskAttributes.categoryId.optional(),
  estimatedDurationMin: taskAttributes.estimatedDurationMin.optional(),
  priority: taskAttributes.priority.optional(),
  dueDate: taskAttributes.dueDate.optional(),
  preferredRange: taskAttributes.preferredRange.optional(),
  focusLevel: taskAttributes.focusLevel.optional(),
  cooldownOverrideMin: taskAttributes.cooldownOverrideMin.optional(),
});

/**
 * An edit patch distinguishes three states per field, which a partial object
 * alone cannot: absent leaves the value alone, `null` clears it back to
 * inheriting from the nearest ancestor (§4.4), and a value overrides locally.
 * Collapsing "clear" and "leave alone" would make an inherited property
 * impossible to reinstate once overridden.
 */
const editTaskParams = z.object({
  taskId: uuid,
  patch: z.object({
    title: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
    categoryId: taskAttributes.categoryId.nullable().optional(),
    estimatedDurationMin: taskAttributes.estimatedDurationMin.nullable().optional(),
    priority: taskAttributes.priority.nullable().optional(),
    dueDate: taskAttributes.dueDate.nullable().optional(),
    preferredRange: taskAttributes.preferredRange.nullable().optional(),
    focusLevel: taskAttributes.focusLevel.nullable().optional(),
    cooldownOverrideMin: taskAttributes.cooldownOverrideMin.nullable().optional(),
  }),
});

/**
 * Spec §7.4. `isUnavailability` is deliberately absent: a content-free block is
 * `AddUnavailability` below, which is the same insert with the flag set.
 */
const addAppointmentParams = z
  .object({
    calendarId: uuid,
    title: z.string().min(1),
    notes: z.string().optional(),
    start: instant,
    end: instant,
    /** True when every participant is an app user, enabling §7.2 negotiation. */
    isInternal: z.boolean().optional(),
  })
  .refine((params) => params.start < params.end, {
    message: 'An appointment must end after it starts',
  });

const editAppointmentParams = z.object({
  appointmentId: uuid,
  patch: z.object({
    title: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
    interval: z
      .object({ start: instant, end: instant })
      .refine((interval) => interval.start < interval.end, {
        message: 'An appointment must end after it starts',
      })
      .optional(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  }),
});

/**
 * Spec §7.3. A manual reposition sets a soft not-before *and* a preference for
 * the same datetime, then re-derives. The task is delayed, not fixed.
 */
const moveTaskParams = z.object({ taskId: uuid, datetime: instant });

/** Spec §7.3. Increments `defer_count`; sets nothing fixed. */
const deferTaskParams = z.object({
  taskId: uuid,
  target: z.enum(['tomorrow', 'next_week', 'backlog']),
  reason: z.string().optional(),
});

/** Spec §7.3. `actualEnd` is how a task finishing early pulls the day forward. */
const completeTaskParams = z.object({ taskId: uuid, actualEnd: instant.optional() });

/** Spec §7.2. The sick-day action: everything left today moves to later days. */
const postponeRestOfDayParams = z.object({ calendarId: uuid, date: civilDate });

/**
 * Spec §7.2. The vacation action, at week grain. `week` is any local date in
 * the week to clear; the server snaps it to that week's start, since where a
 * week begins is the user's `firstDayOfWeek` setting (§13) and not the caller's
 * to decide.
 */
const clearWeekParams = z.object({ calendarId: uuid, week: civilDate });

/**
 * Spec §7.3. The estimate was wrong, or the task overran; downstream reflows.
 *
 * Distinct from `EditTask` with a duration patch even though the write is the
 * same one, because the *intent* differs and the log is read by people: "this
 * took longer than I thought" is the sentence a future parser will be given,
 * and history that records it as an edit has thrown that away.
 */
const extendTaskParams = z.object({
  taskId: uuid,
  newEstimateMin: taskAttributes.estimatedDurationMin,
});

/** Spec §7.3. Frees the task's footprint without pretending it was done. */
const cancelTaskParams = z.object({ taskId: uuid });

/**
 * Spec §7.3. Exchange two tasks' time positions, if each fits where the other
 * was; the server falls back to `SwapForward` semantics when they do not.
 */
const swapTasksParams = z
  .object({ taskAId: uuid, taskBId: uuid })
  .refine((params) => params.taskAId !== params.taskBId, {
    message: 'A task cannot be swapped with itself',
  });

/** Spec §7.3. "I don't want to work on this now." */
const swapForwardParams = z.object({ taskId: uuid });

/** Spec §7.3. Crossing the hard-horizon boundary (§6.1), in either direction. */
const promoteFromBacklogParams = z.object({ taskId: uuid });
const moveToBacklogParams = z.object({ taskId: uuid });

/**
 * Spec §7.4 — "unavailable 14:00–16:00".
 *
 * No title and no notes: the block is *content-free* by definition, and a
 * command that accepted a title would be `AddAppointment` wearing a flag. The
 * stored row carries `is_unavailability`, which is what tells a UI to label it
 * itself rather than render an invented title back at the user.
 */
const addUnavailabilityParams = z
  .object({ calendarId: uuid, start: instant, end: instant })
  .refine((params) => params.start < params.end, {
    message: 'An unavailability must end after it starts',
  });

/**
 * Spec §7.5. No parameters: undo means "the last thing I did", and letting a
 * caller name an arbitrary target would make it something else — a selective
 * revert, which reverses changes later commands were built on.
 *
 * "The last thing I did" is per actor. The log is the tenant's, but undo is a
 * personal gesture: reaching into a colleague's work because they happened to
 * act more recently is not what anyone means by pressing it.
 */
const undoParams = z.object({});
const redoParams = z.object({});

/**
 * The envelope of spec §7.1.
 *
 * `expectedVersion` is the optimistic lock (§5.4) on the entity the command
 * names — the task for `EditTask`, the appointment for `EditAppointment`, and
 * so on. Commands that name no single entity reject it rather than ignoring it;
 * see `commandTarget` on the server.
 */
const envelope = {
  id: uuid,
  actor: uuid,
  tenantId: uuid,
  expectedVersion: z.int().positive().optional(),
  /**
   * Ties several commands into one atomic unit of history (§7.5): undo reverses
   * the whole group or none of it. Absent for a standalone command, which is
   * almost all of them — the bulk actions of §7.2 are single commands that
   * happen to touch many rows, and are already atomic by virtue of being one.
   *
   * Not in §7.1's envelope sketch, but §7.5 requires command groups to exist
   * and the log has carried the column since the schema was laid down. A caller
   * that never sets it gets exactly the behaviour §7.1 describes.
   */
  groupId: uuid.optional(),
  issuedAt: instant,
} as const;

function command<T extends string, P extends z.ZodType>(type: T, params: P) {
  return z.object({ ...envelope, type: z.literal(type), params });
}

export const commandSchema = z.discriminatedUnion('type', [
  command('CreateTask', createTaskParams),
  command('EditTask', editTaskParams),
  command('AddAppointment', addAppointmentParams),
  command('EditAppointment', editAppointmentParams),
  command('MoveTask', moveTaskParams),
  command('DeferTask', deferTaskParams),
  command('CompleteTask', completeTaskParams),
  command('PostponeRestOfDay', postponeRestOfDayParams),
  command('ClearWeek', clearWeekParams),
  command('ExtendTask', extendTaskParams),
  command('CancelTask', cancelTaskParams),
  command('SwapTasks', swapTasksParams),
  command('SwapForward', swapForwardParams),
  command('PromoteFromBacklog', promoteFromBacklogParams),
  command('MoveToBacklog', moveToBacklogParams),
  command('AddUnavailability', addUnavailabilityParams),
  command('Undo', undoParams),
  command('Redo', redoParams),
]);

export type Command = z.infer<typeof commandSchema>;
export type CommandType = Command['type'];

/** The params of one command type, narrowed by that type. */
export type CommandParams<T extends CommandType> = Extract<Command, { type: T }>['params'];

export type CreateTaskParams = z.infer<typeof createTaskParams>;
export type EditTaskParams = z.infer<typeof editTaskParams>;
export type AddAppointmentParams = z.infer<typeof addAppointmentParams>;
export type EditAppointmentParams = z.infer<typeof editAppointmentParams>;
export type MoveTaskParams = z.infer<typeof moveTaskParams>;
export type DeferTaskParams = z.infer<typeof deferTaskParams>;
export type CompleteTaskParams = z.infer<typeof completeTaskParams>;
export type PostponeRestOfDayParams = z.infer<typeof postponeRestOfDayParams>;
export type ClearWeekParams = z.infer<typeof clearWeekParams>;
export type ExtendTaskParams = z.infer<typeof extendTaskParams>;
export type CancelTaskParams = z.infer<typeof cancelTaskParams>;
export type SwapTasksParams = z.infer<typeof swapTasksParams>;
export type SwapForwardParams = z.infer<typeof swapForwardParams>;
export type PromoteFromBacklogParams = z.infer<typeof promoteFromBacklogParams>;
export type MoveToBacklogParams = z.infer<typeof moveToBacklogParams>;
export type AddUnavailabilityParams = z.infer<typeof addUnavailabilityParams>;

/** Every command type, for exhaustiveness checks and registry guards. */
export const COMMAND_TYPES = commandSchema.options.map(
  (option) => option.shape.type.value,
) as readonly CommandType[];

/** A command before it has an identity — what a caller actually writes. */
type WithoutIdentity<T> = T extends unknown ? Omit<T, 'id' | 'issuedAt'> : never;
export type CommandDraft = WithoutIdentity<Command>;

/**
 * Stamps a draft with an id and an issue time.
 *
 * Both are overridable so tests can pin them; the defaults are a fresh UUID v7
 * and the wall clock. This is the one place in the write path that reads a
 * clock — everything downstream, the scheduler included, takes `now` as an
 * explicit input (spec §6.3).
 */
export function newCommand<D extends CommandDraft>(
  draft: D,
  identity: { id?: string; issuedAt?: string } = {},
): D & { id: string; issuedAt: string } {
  return {
    ...draft,
    id: identity.id ?? uuidv7(),
    issuedAt: identity.issuedAt ?? new Date().toISOString(),
  };
}
