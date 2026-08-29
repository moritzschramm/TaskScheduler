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
 * Milestone M6 covers this set; the rest of §7.3–7.5 arrives in M7.
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
 * `AddUnavailability`, its own command in M7. The column exists and defaults to
 * false, so adding that command stays additive.
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

/** Spec §7.2. The vacation action, at week grain. */
const clearWeekParams = z.object({ calendarId: uuid, weekStart: civilDate });

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
