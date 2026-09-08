import { z } from 'zod';
import { CATEGORY_COLORS } from './palette.js';
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
 * parser's target. `CreateTask`, `EditTask`, `EditAppointment` and the
 * configuration family below are not named in §7 and follow the obvious
 * convention.
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

/**
 * An RRULE and the zone it is read in — the shape both fixed-block commands
 * take (§8.1).
 *
 * Defined once because it *is* one thing. `AddUnavailability` was written
 * without it, so the editor's repeat control was accepted and dropped; sharing
 * the definition is what keeps the two from drifting again.
 */
const appointmentRecurrence = z.object({
  rule: z.string().min(1),
  timeZone: z.string().min(1),
});

const preferredRange = z
  .object({ startMin: minuteOfDay, endMin: minuteOfDay })
  .refine((range) => range.startMin < range.endMin, {
    message: 'preferredRange.startMin must be before endMin',
  });

/**
 * A task's recurrence — a **demand** rule, not a datetime rule (spec §8.2).
 *
 * "Exercise 3× per week" says how much of something a period should contain; it
 * says nothing about when. Each period the generator spawns that many
 * occurrences and the scheduler places them flexibly within the period, which
 * is the whole difference from an appointment's recurrence (§8.1) — that one
 * expands a rule into fixed datetimes, and the two must not be collapsed into
 * one mechanism however similar they look in a UI.
 *
 * `missedPolicy` is what happens when a period ends with demand unmet.
 * Rollover carries it into the next period as debt; expire drops it. §8.2's own
 * example is the reason both exist: a missed workout should not distort the
 * next day, while a missed invoice must carry over.
 */
const recurrence = z.object({
  period: z.enum(['day', 'week', 'month']),
  /** How many occurrences each period should contain. */
  count: z.int().min(1).max(50),
  missedPolicy: z.enum(['rollover', 'expire']).optional(),
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

export const createTaskParams = z.object({
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
  recurrence: recurrence.optional(),
});

/**
 * An edit patch distinguishes three states per field, which a partial object
 * alone cannot: absent leaves the value alone, `null` clears it back to
 * inheriting from the nearest ancestor (§4.4), and a value overrides locally.
 * Collapsing "clear" and "leave alone" would make an inherited property
 * impossible to reinstate once overridden.
 */
export const editTaskParams = z.object({
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
    /**
     * `null` stops the task recurring. Not an inheritance clear — recurrence is
     * not one of §4.4's inheritable properties, and a subtask does not inherit
     * "3× per week" from the thing it is part of.
     */
    recurrence: recurrence.nullable().optional(),
  }),
});

export type TaskRecurrence = z.infer<typeof recurrence>;

/**
 * Spec §7.4. `isUnavailability` is deliberately absent: a content-free block is
 * `AddUnavailability` below, which is the same insert with the flag set.
 */
export const addAppointmentParams = z
  .object({
    calendarId: uuid,
    title: z.string().min(1),
    notes: z.string().optional(),
    start: instant,
    end: instant,
    /** True when every participant is an app user, enabling §7.2 negotiation. */
    isInternal: z.boolean().optional(),
    /**
     * An RFC 5545 rule and the zone its wall-clock times mean (spec §8.1, §5.1).
     *
     * The zone travels with the rule and is not optional, because "every
     * weekday at 09:00" is not a statement about instants: it means a different
     * moment either side of a DST boundary, and a rule stored without a zone
     * cannot be expanded twice the same way.
     *
     * This is **datetime expansion** — the other recurrence engine, a task's
     * per-period demand (§8.2), is a different mechanism entirely and lives on
     * `CreateTask`.
     */
    recurrence: appointmentRecurrence.optional(),
  })
  .refine((params) => params.start < params.end, {
    message: 'An appointment must end after it starts',
  });

/**
 * Spec §8.1: editing a series exposes "this occurrence only" versus "this and
 * all future occurrences".
 *
 * `occurrenceStart` names *which* instance is being edited, and is required for
 * anything but a whole-series edit — an instance has no id of its own, because
 * it is not a row until something makes it one.
 */
export const editAppointmentParams = z.object({
  appointmentId: uuid,
  /**
   * `series` edits the template and every instance with it; `occurrence`
   * detaches one; `this_and_future` ends the old series and starts a new one.
   */
  scope: z.enum(['series', 'occurrence', 'this_and_future']).optional(),
  /** The unmodified start of the instance being edited. */
  occurrenceStart: instant.optional(),
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
export const moveTaskParams = z.object({ taskId: uuid, datetime: instant });

/**
 * `ClearFloor(task)` — the "explicit user reset" of spec §7.3.
 *
 * §7.3 lists three ways a manual floor goes away: completion, a bulk
 * reschedule, and a user resetting it. The first two happen as side effects of
 * other commands; the third has no command of its own in §7, and without one a
 * floor set by a mistaken drag can only be replaced, never removed — the task
 * would stay "not before Thursday" for ever, with the reason long forgotten.
 *
 * Clears the bias with it. They are set together by `MoveTask` and mean one
 * thing between them; a bias surviving its floor would keep pulling the task
 * towards a time the user has just said they no longer care about.
 */
export const clearFloorParams = z.object({ taskId: uuid });

/** Spec §7.3. Increments `defer_count`; sets nothing fixed. */
export const deferTaskParams = z.object({
  taskId: uuid,
  target: z.enum(['tomorrow', 'next_week', 'backlog']),
  reason: z.string().optional(),
});

/** Spec §7.3. `actualEnd` is how a task finishing early pulls the day forward. */
export const completeTaskParams = z.object({ taskId: uuid, actualEnd: instant.optional() });

/** Spec §7.2. The sick-day action: everything left today moves to later days. */
export const postponeRestOfDayParams = z.object({ calendarId: uuid, date: civilDate });

/**
 * Spec §7.2's sick day, said the other way round — the one a person reaches for.
 *
 * `PostponeRestOfDay` pushes each task past a floor, which reads as an
 * instruction to the scheduler about tasks. But somebody who wakes up ill is
 * not making a decision about their tasks; they are making one about their
 * *day*, and the tasks are a consequence. Saying it as "this day is not
 * available" gets the consequence for free — the day has no capacity, so
 * nothing can be placed in it — and needs no floor per task, so undoing it is
 * removing what it added rather than restoring forty replaced floors.
 *
 * It also holds. A floor stops a task being scheduled before an instant, and
 * nothing stops a later command from putting something back on the day; the
 * blocks stay until somebody takes them away.
 *
 * Existing appointments are left where they are and reported for attention
 * (§7.2): being unavailable is not the same as those meetings having been
 * cancelled, and cancelling them is not this command's to assume.
 */
export const blockOutDayParams = z.object({ calendarId: uuid, date: civilDate });

/**
 * Spec §7.2. The vacation action, at week grain. `week` is any local date in
 * the week to clear; the server snaps it to that week's start, since where a
 * week begins is the user's `firstDayOfWeek` setting (§13) and not the caller's
 * to decide.
 */
export const clearWeekParams = z.object({ calendarId: uuid, week: civilDate });

/**
 * Spec §7.3. The estimate was wrong, or the task overran; downstream reflows.
 *
 * Distinct from `EditTask` with a duration patch even though the write is the
 * same one, because the *intent* differs and the log is read by people: "this
 * took longer than I thought" is the sentence a future parser will be given,
 * and history that records it as an edit has thrown that away.
 */
export const extendTaskParams = z.object({
  taskId: uuid,
  newEstimateMin: taskAttributes.estimatedDurationMin,
});

/** Spec §7.3. Frees the task's footprint without pretending it was done. */
export const cancelTaskParams = z.object({ taskId: uuid });

/**
 * Spec §7.3. Exchange two tasks' time positions, if each fits where the other
 * was; the server falls back to `SwapForward` semantics when they do not.
 */
export const swapTasksParams = z
  .object({ taskAId: uuid, taskBId: uuid })
  .refine((params) => params.taskAId !== params.taskBId, {
    message: 'A task cannot be swapped with itself',
  });

/** Spec §7.3. "I don't want to work on this now." */
export const swapForwardParams = z.object({ taskId: uuid });

/** Spec §7.3. Crossing the hard-horizon boundary (§6.1), in either direction. */
export const promoteFromBacklogParams = z.object({ taskId: uuid });
export const moveToBacklogParams = z.object({ taskId: uuid });

/**
 * Spec §7.4 — "unavailable 14:00–16:00".
 *
 * No title and no notes: the block is *content-free* by definition, and a
 * command that accepted a title would be `AddAppointment` wearing a flag. The
 * stored row carries `is_unavailability`, which is what tells a UI to label it
 * itself rather than render an invented title back at the user.
 */
export const addUnavailabilityParams = z
  .object({
    calendarId: uuid,
    start: instant,
    end: instant,
    /**
     * The same rule an appointment takes (§8.1).
     *
     * It was missing, and the editor offered the control anyway — so "every
     * weekday, unavailable" was accepted, logged, and expanded into exactly one
     * block. The engine treats the two the same (§6.2 rule 2); the only
     * difference is that one has words in it, and repeating is not about words.
     */
    recurrence: appointmentRecurrence.optional(),
  })
  .refine((params) => params.start < params.end, {
    message: 'An unavailability must end after it starts',
  });

/**
 * Configuration — the calendars, categories and windows the engine schedules
 * *within* (spec §4.3, §9.1).
 *
 * §7 names no command for any of these, because it enumerates what a user does
 * to their *schedule*. But configuration is state, and the command layer is the
 * single write path (§3.2): a settings screen that wrote directly would be a
 * second one — unlogged, un-undoable, invisible to audit (§12) and to the
 * future parser. So they follow the `CreateTask` convention above, named for
 * what they do.
 *
 * **The window families replace sets, not rows.** §4.3 describes a category as
 * owning "the set of availability windows for its kind of activity" and a
 * week-type override as replacing "the default window set": the unit that means
 * something is the set, and a weekly editor submits one. Per-row commands would
 * turn "Mon–Thu 09:00–17:00, Fri 09:00–13:00" into five commands, five undos,
 * and four intermediate states in which the calendar was wrong — and each of
 * those intermediate states would re-derive.
 */

/**
 * An IANA zone name, checked against the runtime's own zone database rather
 * than a pattern.
 *
 * `Europe/Berln` satisfies every plausible regex and then fails at derive time,
 * where the failure is a solve that cannot resolve a single window rather than
 * a rejected field (§5.1).
 */
const timeZone = z.string().refine(
  (zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown IANA time zone' },
);

const visibilityScope = z.enum(['private', 'team', 'group']);

/** ISO-8601 weekday and a half-open local range — the shape both windows share. */
const weekdayRule = {
  /** 1 = Monday … 7 = Sunday, matching Postgres `extract(isodow)`. */
  weekday: z.int().min(1).max(7),
  startMin: minuteOfDay,
  endMin: minuteOfDay,
} as const;

const ordered = (rule: { startMin: number; endMin: number }) => rule.startMin < rule.endMin;
const orderedMessage = { message: 'A window must end after it starts' };

const calendarWindowRule = z.object(weekdayRule).refine(ordered, orderedMessage);

/** A window's own focus profile, matched against a task's `focus_level` (§6.5). */
const availabilityWindowRule = z
  .object({ ...weekdayRule, focusLevel: z.int().min(1).max(5).optional() })
  .refine(ordered, orderedMessage);

/**
 * Spec §4.3. A user "may own several" calendars, so creating one is an action
 * they take; the tenant is the envelope's and the owner is the actor, neither
 * of which a client may choose (§10.2).
 */
export const createCalendarParams = z.object({
  name: z.string().min(1),
  timezone: timeZone,
  visibilityScope: visibilityScope.optional(),
});

export const configureCalendarParams = z.object({
  calendarId: uuid,
  patch: z.object({
    name: z.string().min(1).optional(),
    timezone: timeZone.optional(),
    visibilityScope: visibilityScope.optional(),
  }),
});

/**
 * Spec §9.1 — the working window (when tasks may be placed) and the shareable
 * window (what busy time other users see, §9.2). One command for both because
 * they are the same shape and differ only in what reads them.
 */
export const setCalendarWindowsParams = z.object({
  calendarId: uuid,
  kind: z.enum(['working', 'shareable']),
  windows: z.array(calendarWindowRule),
});

/** Spec §4.3. Tenant-scoped, and owns the default cooldown for its tasks. */
export const createCategoryParams = z.object({
  name: z.string().min(1),
  defaultCooldownMin: z.int().nonnegative().optional(),
  /** Omitted takes the next free slot in order; see `nextCategoryColor`. */
  color: z.enum(CATEGORY_COLORS).optional(),
});

/**
 * No `null` anywhere in the patch: neither field is nullable in the domain — a
 * category always has a name, and its cooldown defaults to zero rather than to
 * absent — so there is nothing to clear back to (contrast `EditTask`, where
 * clearing means reverting to an inherited value).
 */
export const editCategoryParams = z.object({
  categoryId: uuid,
  patch: z.object({
    name: z.string().min(1).optional(),
    defaultCooldownMin: z.int().nonnegative().optional(),
    /**
     * The one nullable field in this patch, and the exception the comment above
     * describes: `null` means "no colour", which is where a ninth activity type
     * starts and somewhere a user may deliberately go back to.
     */
    color: z.enum(CATEGORY_COLORS).nullable().optional(),
  }),
});

export const deleteCategoryParams = z.object({ categoryId: uuid });

/**
 * Replaces the whole set for one (calendar, category) pair.
 *
 * `weekTypeOverrideId` absent addresses the default set; present addresses that
 * override's replacement set (§4.3). It is part of the address rather than a
 * filter, which is why an empty `windows` array is meaningful: it says this
 * category is not available at all here, and during a holiday override that is
 * exactly the intent.
 */
export const setAvailabilityWindowsParams = z.object({
  calendarId: uuid,
  categoryId: uuid,
  weekTypeOverrideId: uuid.optional(),
  windows: z.array(availabilityWindowRule),
});

/** Spec §4.3 — holidays, a conference week, parental leave. Half-open dates. */
export const createWeekTypeOverrideParams = z
  .object({
    calendarId: uuid,
    name: z.string().min(1),
    startDate: civilDate,
    endDate: civilDate,
  })
  .refine((params) => params.startDate < params.endDate, {
    message: 'A week-type override must end after it starts',
  });

/**
 * Either date may move alone, so the ordering can only be checked here when
 * both are present; the handler re-checks the merged result, and the
 * `week_type_overrides_date_range` constraint is the backstop under both.
 */
export const editWeekTypeOverrideParams = z.object({
  weekTypeOverrideId: uuid,
  patch: z
    .object({
      name: z.string().min(1).optional(),
      startDate: civilDate.optional(),
      endDate: civilDate.optional(),
    })
    .refine(
      (patch) =>
        patch.startDate === undefined || patch.endDate === undefined
          ? true
          : patch.startDate < patch.endDate,
      { message: 'A week-type override must end after it starts' },
    ),
});

export const deleteWeekTypeOverrideParams = z.object({ weekTypeOverrideId: uuid });

/**
 * `UpdateSettings(patch)` — spec §13's user settings.
 *
 * "Date/time formatting, first-day-of-week, locale, and timezone are user
 * settings." All three are nullable in the patch, and `null` means *unset*
 * rather than a default: a user who clears their timezone goes back to
 * following whichever calendar they are looking at, which is what they had
 * before they ever opened this screen.
 *
 * A command like everything else. It changes no schedule and re-derives
 * nothing, but the single write path (§3.2) has no exceptions worth carving.
 */
export const updateSettingsParams = z.object({
  patch: z.object({
    /** A BCP-47 tag, e.g. `en-GB`. Formatting only. */
    locale: z.string().min(2).nullable().optional(),
    /** An IANA zone name. Display only — a calendar keeps its own (§5.1). */
    timeZone: timeZone.nullable().optional(),
    /** 1 = Monday … 7 = Sunday. */
    firstDayOfWeek: z.int().min(1).max(7).nullable().optional(),
  }),
});

/**
 * `MarkNotificationsRead(ids)` — dismissing what the engine told you (§11).
 *
 * Not named in §7, and it changes nothing about the schedule. It is a command
 * anyway because the single write path (§3.2) has no exceptions worth carving:
 * the moment one screen is allowed to `PATCH` a row directly, there are two
 * write paths and the second one is invisible to the log.
 *
 * A list rather than one id, so "mark all read" is one entry in the history and
 * one undo, rather than eleven of each.
 */
export const markNotificationsReadParams = z.object({
  notificationIds: z.array(uuid).min(1),
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
export const undoParams = z.object({});
export const redoParams = z.object({});

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
  command('ClearFloor', clearFloorParams),
  command('DeferTask', deferTaskParams),
  command('CompleteTask', completeTaskParams),
  command('PostponeRestOfDay', postponeRestOfDayParams),
  command('BlockOutDay', blockOutDayParams),
  command('ClearWeek', clearWeekParams),
  command('ExtendTask', extendTaskParams),
  command('CancelTask', cancelTaskParams),
  command('SwapTasks', swapTasksParams),
  command('SwapForward', swapForwardParams),
  command('PromoteFromBacklog', promoteFromBacklogParams),
  command('MoveToBacklog', moveToBacklogParams),
  command('AddUnavailability', addUnavailabilityParams),
  command('MarkNotificationsRead', markNotificationsReadParams),
  command('UpdateSettings', updateSettingsParams),
  command('CreateCalendar', createCalendarParams),
  command('ConfigureCalendar', configureCalendarParams),
  command('SetCalendarWindows', setCalendarWindowsParams),
  command('CreateCategory', createCategoryParams),
  command('EditCategory', editCategoryParams),
  command('DeleteCategory', deleteCategoryParams),
  command('SetAvailabilityWindows', setAvailabilityWindowsParams),
  command('CreateWeekTypeOverride', createWeekTypeOverrideParams),
  command('EditWeekTypeOverride', editWeekTypeOverrideParams),
  command('DeleteWeekTypeOverride', deleteWeekTypeOverrideParams),
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
export type ClearFloorParams = z.infer<typeof clearFloorParams>;
export type DeferTaskParams = z.infer<typeof deferTaskParams>;
export type CompleteTaskParams = z.infer<typeof completeTaskParams>;
export type PostponeRestOfDayParams = z.infer<typeof postponeRestOfDayParams>;
export type BlockOutDayParams = z.infer<typeof blockOutDayParams>;
export type ClearWeekParams = z.infer<typeof clearWeekParams>;
export type ExtendTaskParams = z.infer<typeof extendTaskParams>;
export type CancelTaskParams = z.infer<typeof cancelTaskParams>;
export type SwapTasksParams = z.infer<typeof swapTasksParams>;
export type SwapForwardParams = z.infer<typeof swapForwardParams>;
export type PromoteFromBacklogParams = z.infer<typeof promoteFromBacklogParams>;
export type MoveToBacklogParams = z.infer<typeof moveToBacklogParams>;
export type AddUnavailabilityParams = z.infer<typeof addUnavailabilityParams>;
export type MarkNotificationsReadParams = z.infer<typeof markNotificationsReadParams>;
export type UpdateSettingsParams = z.infer<typeof updateSettingsParams>;
export type CreateCalendarParams = z.infer<typeof createCalendarParams>;
export type ConfigureCalendarParams = z.infer<typeof configureCalendarParams>;
export type SetCalendarWindowsParams = z.infer<typeof setCalendarWindowsParams>;
export type CreateCategoryParams = z.infer<typeof createCategoryParams>;
export type EditCategoryParams = z.infer<typeof editCategoryParams>;
export type DeleteCategoryParams = z.infer<typeof deleteCategoryParams>;
export type SetAvailabilityWindowsParams = z.infer<typeof setAvailabilityWindowsParams>;
export type CreateWeekTypeOverrideParams = z.infer<typeof createWeekTypeOverrideParams>;
export type EditWeekTypeOverrideParams = z.infer<typeof editWeekTypeOverrideParams>;
export type DeleteWeekTypeOverrideParams = z.infer<typeof deleteWeekTypeOverrideParams>;
export type UndoParams = z.infer<typeof undoParams>;
export type RedoParams = z.infer<typeof redoParams>;

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

/**
 * The shortest password the server accepts (spec §10.1).
 *
 * Here rather than in either half, because both need it and neither owns it:
 * the server configures Better Auth with it and the sign-up form states it
 * before anyone types. It lived in both, agreeing by coincidence with the
 * library's default — so a library upgrade, or an edit to one copy, would have
 * moved the rule without moving what the form promised.
 *
 * The maximum is bcrypt's: input past 72 bytes is ignored by the algorithm, so
 * accepting more would be accepting a passphrase that is quietly truncated.
 */
export const MINIMUM_PASSWORD_LENGTH = 8;
export const MAXIMUM_PASSWORD_LENGTH = 72;
