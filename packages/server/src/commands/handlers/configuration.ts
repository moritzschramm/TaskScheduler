import { and, eq, isNull, sql } from 'drizzle-orm';
import { nextActivityTypeColor } from '@ambitime/shared';
import {
  availabilityWindows,
  calendars,
  calendarWindows,
  activityTypes,
  tasks,
  weekTypeOverrides,
} from '../../db/schema/index.js';
import { checkVersion, type CommandContext, type HandlerOutcome } from '../context.js';
import { EntityNotFoundError, PreconditionFailedError } from '../errors.js';
import { deleteWhere, insertRow, updateRow } from '../journal.js';
import type {
  ConfigureCalendarParams,
  CreateCalendarParams,
  CreateActivityTypeParams,
  CreateWeekTypeOverrideParams,
  DeleteActivityTypeParams,
  DeleteWeekTypeOverrideParams,
  EditActivityTypeParams,
  EditWeekTypeOverrideParams,
  SetAvailabilityWindowsParams,
  SetCalendarWindowsParams,
} from '@ambitime/shared';
import type {
  Calendar,
  ActivityType,
  NewAvailabilityWindow,
  NewCalendar,
  NewCalendarWindow,
  NewActivityType,
  NewWeekTypeOverride,
  WeekTypeOverride,
} from '../../db/schema/index.js';

/**
 * Configuration — the calendars, activity types and windows tasks are scheduled
 * *within* (spec §4.3, §9.1).
 *
 * These go through the command layer for the same reason everything else does
 * (§3.2), and the payoff is concrete rather than architectural: moving a
 * working window reflows a fortnight of placements, and a person who did that
 * by accident wants one gesture to put it back. Undo already has that gesture,
 * and it works here because the journal records these tables (§12).
 *
 * **Set replacement, not row editing.** `SetCalendarWindows` and
 * `SetAvailabilityWindows` each replace an entire addressed set. A weekly
 * editor submits a week; five row commands would be five log entries, five
 * undos, and four intermediate states in which the calendar was wrong — each of
 * which would re-derive and each of which a user could see.
 */

/** SQLSTATE 23505 — a name already taken within the tenant. */
const UNIQUE_VIOLATION = '23505';

export async function createCalendar(
  params: CreateCalendarParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const values: NewCalendar = {
    tenantId: ctx.tenantId,
    // The actor owns what they create (§10.2); a client cannot nominate someone
    // else, which is also what `calendars_owner_requires_membership_fk` needs.
    ownerId: ctx.actorId,
    name: params.name,
    timezone: params.timezone,
    ...(params.visibilityScope === undefined ? {} : { visibilityScope: params.visibilityScope }),
  };

  const calendarId = await named(
    () => insertRow(ctx, 'calendars', values),
    `You already have a calendar called "${params.name}"`,
  );

  // Derived immediately, empty: the placement cache is a total function of
  // source state (§3.4), and "no rows yet" is a state it should hold for too.
  return { calendarIds: [calendarId] };
}

export async function configureCalendar(
  params: ConfigureCalendarParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const calendar = await lockCalendar(ctx, params.calendarId);
  const { patch } = params;
  const values: Partial<NewCalendar> = {};

  if (patch.name !== undefined) values.name = patch.name;
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.visibilityScope !== undefined) values.visibilityScope = patch.visibilityScope;

  if (Object.keys(values).length > 0) {
    await named(
      () => updateRow(ctx, 'calendars', calendar.id, values),
      `You already have a calendar called "${patch.name ?? calendar.name}"`,
    );
  }

  // The zone is what every wall-clock rule resolves against (§5.1), so changing
  // it moves every window and therefore every placement.
  return { calendarIds: [calendar.id] };
}

/**
 * Replaces one of the two windows of spec §9.1.
 *
 * The `working` set is what the scheduler may place within; the `shareable` set
 * is what other users see as busy (§9.2). Only the first re-derives — free/busy
 * exposure changes what a *different* user's context can see, and this
 * calendar's own schedule is unaffected by it. Claiming otherwise by deriving
 * anyway would tell a user their day had been recalculated when it had not.
 */
export async function setCalendarWindows(
  params: SetCalendarWindowsParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const calendar = await lockCalendar(ctx, params.calendarId);

  await deleteWhere(
    ctx,
    'calendar_windows',
    and(eq(calendarWindows.calendarId, calendar.id), eq(calendarWindows.kind, params.kind))!,
  );

  for (const rule of orderRules(params.windows)) {
    const values: NewCalendarWindow = {
      tenantId: ctx.tenantId,
      calendarId: calendar.id,
      kind: params.kind,
      weekday: rule.weekday,
      startMin: rule.startMin,
      endMin: rule.endMin,
    };
    await insertRow(ctx, 'calendar_windows', values);
  }

  return { calendarIds: params.kind === 'working' ? [calendar.id] : [] };
}

export async function createActivityType(
  params: CreateActivityTypeParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  // The next free slot when the caller named none, so the first activity types
  // get distinct colours without anybody choosing (§4.3). Read here rather than
  // defaulted in the schema because it depends on the other rows.
  const taken = await ctx.tx.select({ color: activityTypes.color }).from(activityTypes);
  const color = params.color ?? nextActivityTypeColor(taken.map((row) => row.color));

  const values: NewActivityType = {
    tenantId: ctx.tenantId,
    name: params.name,
    color,
    ...(params.defaultCooldownMin === undefined
      ? {}
      : { defaultCooldownMin: params.defaultCooldownMin }),
  };

  await named(
    () => insertRow(ctx, 'activity_types', values),
    `An activity type called "${params.name}" already exists`,
  );

  // A brand-new activity type has no windows and no tasks, so no calendar's
  // schedule can have changed. Nothing to derive.
  return { calendarIds: [] };
}

export async function editActivityType(
  params: EditActivityTypeParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const activityType = await lockActivityType(ctx, params.activityTypeId);
  const { patch } = params;
  const values: Partial<NewActivityType> = {};

  if (patch.name !== undefined) values.name = patch.name;
  if (patch.defaultCooldownMin !== undefined) values.defaultCooldownMin = patch.defaultCooldownMin;
  // `null` is a value here, not an omission — see the patch schema.
  if (patch.color !== undefined) values.color = patch.color;

  if (Object.keys(values).length === 0) return { calendarIds: [] };

  await named(
    () => updateRow(ctx, 'activity_types', activityType.id, values),
    `An activity type called "${patch.name ?? activityType.name}" already exists`,
  );

  // Only the cooldown reaches the engine (§6.2 rule 4). A colour is a fact
  // about drawing and reaches it even less; renaming an activity type
  // changes a label, and re-deriving every calendar that uses it to discover
  // that nothing moved would be work nobody asked for.
  return {
    calendarIds:
      patch.defaultCooldownMin === undefined ? [] : await usingActivityType(ctx, activityType.id),
  };
}

/**
 * Removes an activity type and the availability windows that belonged to it.
 *
 * **Refused while any task still uses it.** The database would happily
 * `ON DELETE SET NULL` those tasks, which is the right shape for a cascade but
 * the wrong answer for a person: a task with no activity type matches no window and
 * silently stops being schedulable (§6.2 rule 1). Better to say so and let them
 * move the tasks.
 *
 * The windows are deleted here rather than left to the cascade, because a
 * cascade happens inside the database and the journal never sees it — undo
 * would restore the activity type and none of its windows (§12).
 */
export async function deleteActivityType(
  params: DeleteActivityTypeParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const activityType = await lockActivityType(ctx, params.activityTypeId);

  const [inUse] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(eq(tasks.activityTypeId, activityType.id));

  if ((inUse?.count ?? 0) > 0) {
    throw new PreconditionFailedError(
      `Activity type "${activityType.name}" still has ${inUse?.count} task(s); move them to another activity type first`,
    );
  }

  const affected = await usingActivityType(ctx, activityType.id);

  await deleteWhere(
    ctx,
    'availability_windows',
    eq(availabilityWindows.activityTypeId, activityType.id),
  );
  await deleteWhere(ctx, 'activity_types', eq(activityTypes.id, activityType.id));

  return { calendarIds: affected };
}

/**
 * Replaces the availability set for one (calendar, activity type, week-type) address
 * (spec §4.3).
 *
 * An empty `windows` array is a meaningful instruction, not a no-op: it says
 * this activity type is not available here at all, which during a holiday override
 * is exactly what a person means.
 */
export async function setAvailabilityWindows(
  params: SetAvailabilityWindowsParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const calendar = await lockCalendar(ctx, params.calendarId);
  const activityType = await requireActivityType(ctx, params.activityTypeId);
  const override =
    params.weekTypeOverrideId === undefined
      ? undefined
      : await requireWeekTypeOverride(ctx, params.weekTypeOverrideId);

  if (override !== undefined && override.calendarId !== calendar.id) {
    throw new PreconditionFailedError(
      `Week-type override ${override.id} belongs to a different calendar`,
    );
  }

  await deleteWhere(
    ctx,
    'availability_windows',
    and(
      eq(availabilityWindows.calendarId, calendar.id),
      eq(availabilityWindows.activityTypeId, activityType.id),
      // NULL is not equal to anything, itself included, so the default set has
      // to be addressed with `IS NULL` rather than a comparison.
      override === undefined
        ? isNull(availabilityWindows.weekTypeOverrideId)
        : eq(availabilityWindows.weekTypeOverrideId, override.id),
    )!,
  );

  for (const rule of orderRules(params.windows)) {
    const values: NewAvailabilityWindow = {
      tenantId: ctx.tenantId,
      calendarId: calendar.id,
      activityTypeId: activityType.id,
      weekTypeOverrideId: override?.id ?? null,
      weekday: rule.weekday,
      startMin: rule.startMin,
      endMin: rule.endMin,
      ...(rule.focusLevel === undefined ? {} : { focusLevel: rule.focusLevel }),
    };
    await insertRow(ctx, 'availability_windows', values);
  }

  return { calendarIds: [calendar.id] };
}

export async function createWeekTypeOverride(
  params: CreateWeekTypeOverrideParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const calendar = await lockCalendar(ctx, params.calendarId);

  const values: NewWeekTypeOverride = {
    tenantId: ctx.tenantId,
    calendarId: calendar.id,
    name: params.name,
    startDate: params.startDate,
    endDate: params.endDate,
  };

  await insertRow(ctx, 'week_type_overrides', values);

  // An override with no windows of its own *replaces* the default set with
  // nothing (§4.3), so creating one immediately empties its date range. That is
  // the documented meaning, and re-deriving is how the user sees it.
  return { calendarIds: [calendar.id] };
}

export async function editWeekTypeOverride(
  params: EditWeekTypeOverrideParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const override = await lockWeekTypeOverride(ctx, params.weekTypeOverrideId);
  const { patch } = params;
  const values: Partial<NewWeekTypeOverride> = {};

  if (patch.name !== undefined) values.name = patch.name;
  if (patch.startDate !== undefined) values.startDate = patch.startDate;
  if (patch.endDate !== undefined) values.endDate = patch.endDate;

  // Either date may move alone, so ordering can only be checked against the
  // merged result. The `week_type_overrides_date_range` constraint says the
  // same thing underneath; saying it here turns a 500 into a sentence.
  const startDate = patch.startDate ?? override.startDate;
  const endDate = patch.endDate ?? override.endDate;
  if (startDate >= endDate) {
    throw new PreconditionFailedError(
      `A week-type override must end after it starts, but ${startDate} is not before ${endDate}`,
    );
  }

  if (Object.keys(values).length > 0) {
    await updateRow(ctx, 'week_type_overrides', override.id, values);
  }

  return { calendarIds: [override.calendarId] };
}

/**
 * Removes an override, and with it the availability set that replaced the
 * default one for its range — which is what puts the default set back.
 *
 * Its windows are deleted explicitly for the same reason as an activity type's: a
 * database cascade is invisible to the journal, and an undo that restored the
 * override without its windows would restore an override that empties its own
 * date range.
 */
export async function deleteWeekTypeOverride(
  params: DeleteWeekTypeOverrideParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const override = await lockWeekTypeOverride(ctx, params.weekTypeOverrideId);

  await deleteWhere(
    ctx,
    'availability_windows',
    eq(availabilityWindows.weekTypeOverrideId, override.id),
  );
  await deleteWhere(ctx, 'week_type_overrides', eq(weekTypeOverrides.id, override.id));

  return { calendarIds: [override.calendarId] };
}

/**
 * A deterministic insertion order for a replaced set (spec §6.3).
 *
 * The rows get time-ordered ids, so the order they are written in is the order
 * they carry for ever after. Sorting means two clients submitting the same week
 * in different orders produce the same rows, and a golden test of a derived
 * schedule does not depend on which checkbox was clicked first.
 */
function orderRules<T extends { weekday: number; startMin: number; endMin: number }>(
  rules: readonly T[],
): T[] {
  return [...rules].sort(
    (a, b) => a.weekday - b.weekday || a.startMin - b.startMin || a.endMin - b.endMin,
  );
}

/**
 * The calendars whose schedule depends on an activity type: those with a window for
 * it, and those with a task in it.
 *
 * Both halves are needed. A calendar with windows but no tasks changes shape
 * when the activity type's cooldown moves; a calendar with tasks but no windows has
 * demand that is already unschedulable and stays that way — but its
 * diagnostics change, and diagnostics are part of the derived answer (§6.7).
 */
async function usingActivityType(ctx: CommandContext, activityTypeId: string): Promise<string[]> {
  const [windowed, tasked] = await Promise.all([
    ctx.tx
      .selectDistinct({ calendarId: availabilityWindows.calendarId })
      .from(availabilityWindows)
      .where(eq(availabilityWindows.activityTypeId, activityTypeId)),
    ctx.tx
      .selectDistinct({ calendarId: tasks.calendarId })
      .from(tasks)
      .where(eq(tasks.activityTypeId, activityTypeId)),
  ]);

  return [...new Set([...windowed, ...tasked].map((row) => row.calendarId))];
}

/**
 * Loads a calendar for configuration: locked, version-checked, and owned by the
 * actor.
 *
 * RLS has already confined this to the tenant (§5.2), but a tenant is not one
 * person: §4.3 makes a calendar "owned by a User within a Tenant", and §10.2
 * asks for owner predicates on top of the isolation. Reconfiguring a
 * colleague's working window is not something membership alone should allow.
 */
async function lockCalendar(ctx: CommandContext, calendarId: string): Promise<Calendar> {
  const [row] = await ctx.tx
    .select()
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .for('update')
    .limit(1);

  if (!row) throw new EntityNotFoundError('calendar', calendarId);
  if (row.ownerId !== ctx.actorId) {
    throw new PreconditionFailedError(`Calendar ${calendarId} belongs to someone else`);
  }

  checkVersion(ctx, 'calendar', calendarId, row.version);
  return row;
}

/** Activity types are tenant-scoped rather than owned (§4.3), so no owner check. */
async function lockActivityType(
  ctx: CommandContext,
  activityTypeId: string,
): Promise<ActivityType> {
  const [row] = await ctx.tx
    .select()
    .from(activityTypes)
    .where(eq(activityTypes.id, activityTypeId))
    .for('update')
    .limit(1);

  if (!row) throw new EntityNotFoundError('activity type', activityTypeId);
  checkVersion(ctx, 'activity type', activityTypeId, row.version);
  return row;
}

async function lockWeekTypeOverride(
  ctx: CommandContext,
  overrideId: string,
): Promise<WeekTypeOverride> {
  const [row] = await ctx.tx
    .select()
    .from(weekTypeOverrides)
    .where(eq(weekTypeOverrides.id, overrideId))
    .for('update')
    .limit(1);

  if (!row) throw new EntityNotFoundError('week type override', overrideId);
  checkVersion(ctx, 'week type override', overrideId, row.version);
  return row;
}

/** Referenced, not modified — so read without locking or version-checking. */
async function requireActivityType(
  ctx: CommandContext,
  activityTypeId: string,
): Promise<ActivityType> {
  const [row] = await ctx.tx
    .select()
    .from(activityTypes)
    .where(eq(activityTypes.id, activityTypeId))
    .limit(1);

  if (!row) throw new EntityNotFoundError('activity type', activityTypeId);
  return row;
}

async function requireWeekTypeOverride(
  ctx: CommandContext,
  overrideId: string,
): Promise<WeekTypeOverride> {
  const [row] = await ctx.tx
    .select()
    .from(weekTypeOverrides)
    .where(eq(weekTypeOverrides.id, overrideId))
    .limit(1);

  if (!row) throw new EntityNotFoundError('week type override', overrideId);
  return row;
}

/**
 * Turns the database's uniqueness refusal into a sentence about a name.
 *
 * The unique index is the authority — it holds against two concurrent inserts,
 * which a read-then-write check does not — and this only supplies the wording.
 */
async function named<T>(action: () => Promise<T>, message: string): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) {
      throw new PreconditionFailedError(message);
    }
    throw error;
  }
}
