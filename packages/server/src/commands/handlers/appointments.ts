import { lockAppointment, type CommandContext, type HandlerOutcome } from '../context.js';
import { requireCalendar } from '../entities.js';
import { insertRow, updateRow } from '../journal.js';
import { PreconditionFailedError } from '../errors.js';
import { toInstant, toInstantCeil, toIso, toRangeLiteral } from '../../schedule/instants.js';
import type {
  AddAppointmentParams,
  AddUnavailabilityParams,
  EditAppointmentParams,
} from '@ambitime/shared';
import type { Appointment, NewAppointment } from '../../db/schema/index.js';

/**
 * Ad-hoc fixed blocks (spec §7.4).
 *
 * An appointment is a hard constraint: tasks reflow around it, never through it
 * (§6.2 rule 2). Nothing here consults the solver — it changes the source and
 * lets re-derivation work out what that costs.
 *
 * `AddUnavailability` is the same insert with `is_unavailability` set. The
 * engine does not distinguish the two — both are simply time already taken
 * (§7.4) — so nothing downstream of here has a branch for it.
 */

/** SQLSTATE for a GiST exclusion constraint — here, two overlapping blocks. */
const EXCLUSION_VIOLATION = '23P01';

export async function addAppointment(
  params: AddAppointmentParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  await requireCalendar(ctx, params.calendarId);

  const values: NewAppointment = {
    tenantId: ctx.tenantId,
    calendarId: params.calendarId,
    ownerId: ctx.actorId,
    title: params.title,
    notes: params.notes,
    during: interval(params.start, params.end),
    isInternal: params.isInternal,
    recurrenceRule: params.recurrence?.rule,
    recurrenceTimezone: params.recurrence?.timeZone,
  };

  await insertingBlock(() => insertRow(ctx, 'appointments', values), params.calendarId);
  return { calendarIds: [params.calendarId] };
}

/**
 * `AddUnavailability(calendar, [start, end))` — a content-free hard block
 * (spec §7.4).
 *
 * The title is stored empty rather than filled with something like
 * "Unavailable". The column cannot be null, but inventing text would put words
 * in the user's calendar that they never wrote, and a later export or a shared
 * view would show them as if they had. `is_unavailability` carries the meaning;
 * a UI that renders one supplies its own label, in its own language.
 */
export async function addUnavailability(
  params: AddUnavailabilityParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  await requireCalendar(ctx, params.calendarId);

  const values: NewAppointment = {
    tenantId: ctx.tenantId,
    calendarId: params.calendarId,
    ownerId: ctx.actorId,
    title: '',
    during: interval(params.start, params.end),
    isUnavailability: true,
  };

  await insertingBlock(() => insertRow(ctx, 'appointments', values), params.calendarId);
  return { calendarIds: [params.calendarId] };
}

export async function editAppointment(
  params: EditAppointmentParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const appointment = await lockAppointment(ctx, params.appointmentId);
  const scope = params.scope ?? 'series';

  if (scope !== 'series' && appointment.recurrenceRule !== null) {
    return params.occurrenceStart === undefined
      ? refuseWithoutInstance(scope)
      : scope === 'occurrence'
        ? await detachOccurrence(params, ctx, appointment)
        : await splitSeries(params, ctx, appointment);
  }

  const values = patchValues(params);

  await insertingBlock(
    () => updateRow(ctx, 'appointments', appointment.id, values),
    appointment.calendarId,
  );

  return { calendarIds: [appointment.calendarId] };
}

function refuseWithoutInstance(scope: string): never {
  throw new PreconditionFailedError(
    `Editing "${scope}" needs to know which occurrence, and none was named`,
  );
}

/**
 * "This occurrence only" (spec §8.1).
 *
 * The instance becomes a **row**: a modified occurrence pointing at its
 * template and at the instant it replaces. The template is untouched, so every
 * other instance keeps expanding exactly as before — which is the whole promise
 * of "only this one".
 *
 * Deleting one instance is the same act with `status: cancelled`. The row still
 * suppresses the instance it replaced, which is why the loader must look at
 * cancelled overrides too.
 */
async function detachOccurrence(
  params: EditAppointmentParams,
  ctx: CommandContext,
  template: Appointment,
): Promise<HandlerOutcome> {
  const originalStart = toInstant(params.occurrenceStart!);
  const patch = params.patch;

  const duration = rangeDuration(template.during);
  const start = patch.interval?.start ?? toIso(originalStart);
  const end = patch.interval?.end ?? toIso(originalStart + duration);

  const values: NewAppointment = {
    tenantId: ctx.tenantId,
    calendarId: template.calendarId,
    ownerId: ctx.actorId,
    title: patch.title ?? template.title,
    notes: patch.notes === undefined ? template.notes : patch.notes,
    during: interval(start, end),
    isInternal: template.isInternal,
    isUnavailability: template.isUnavailability,
    recurrenceParentId: template.id,
    recurrenceOriginalStart: toIso(originalStart),
    ...(patch.status === undefined ? {} : { status: patch.status }),
  };

  await insertingBlock(() => insertRow(ctx, 'appointments', values), template.calendarId);

  return { calendarIds: [template.calendarId] };
}

/**
 * "This and all future occurrences" (spec §8.1).
 *
 * Modelled as two series rather than one rule with a discontinuity: the old
 * template is given an `UNTIL` ending it before this instance, and a new
 * template carries the change forward. A rule that had to describe "Tuesdays at
 * 09:00 until March and 10:00 after" is not one rule, and RFC 5545 has no way
 * to write it.
 *
 * The instances already detached from the old series stay with it. They are
 * before the split by definition — anything after it belongs to a series that
 * did not exist when they were made.
 */
async function splitSeries(
  params: EditAppointmentParams,
  ctx: CommandContext,
  template: Appointment,
): Promise<HandlerOutcome> {
  const originalStart = toInstant(params.occurrenceStart!);
  const patch = params.patch;

  // `UNTIL` is inclusive in RFC 5545, so the old series must stop a minute
  // before this instance rather than at it.
  const until = toUntilStamp(originalStart - 1);
  const rule = withUntil(template.recurrenceRule!, until);

  await updateRow(ctx, 'appointments', template.id, { recurrenceRule: rule });

  const duration = rangeDuration(template.during);
  const start = patch.interval?.start ?? toIso(originalStart);
  const end = patch.interval?.end ?? toIso(originalStart + duration);

  const values: NewAppointment = {
    tenantId: ctx.tenantId,
    calendarId: template.calendarId,
    ownerId: ctx.actorId,
    title: patch.title ?? template.title,
    notes: patch.notes === undefined ? template.notes : patch.notes,
    during: interval(start, end),
    isInternal: template.isInternal,
    isUnavailability: template.isUnavailability,
    // The same rule, minus any `UNTIL` the old one just acquired: the new
    // series runs on from here with the shape the user set up originally.
    recurrenceRule: stripUntil(template.recurrenceRule!),
    recurrenceTimezone: template.recurrenceTimezone,
    ...(patch.status === undefined ? {} : { status: patch.status }),
  };

  await insertingBlock(() => insertRow(ctx, 'appointments', values), template.calendarId);

  return { calendarIds: [template.calendarId] };
}

function patchValues(params: EditAppointmentParams): Partial<NewAppointment> {
  const { patch } = params;
  const values: Partial<NewAppointment> = {};

  if (patch.title !== undefined) values.title = patch.title;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.interval !== undefined) {
    values.during = interval(patch.interval.start, patch.interval.end);
  }

  return values;
}

/** `["2026-03-23T08:00:00+00","2026-03-23T08:30:00+00")` → 30. */
function rangeDuration(during: string): number {
  const [start, end] = during.slice(1, -1).split(',');
  return toInstantCeil(unquote(end ?? '')) - toInstant(unquote(start ?? ''));
}

function unquote(value: string): string {
  return value.replaceAll('"', '');
}

/** RFC 5545 wants `UNTIL` as a basic-format UTC stamp. */
function toUntilStamp(instant: number): string {
  return `${toIso(instant).replace(/[-:]/g, '').split('.')[0]}Z`;
}

function withUntil(rule: string, until: string): string {
  return `${stripUntil(rule)};UNTIL=${until}`;
}

/** Also drops `COUNT`: a count and an end date cannot both bound one rule. */
function stripUntil(rule: string): string {
  return rule
    .split(';')
    .filter((part) => !/^(UNTIL|COUNT)=/i.test(part))
    .join(';');
}

/**
 * The stored range, rounded outward.
 *
 * A block reserves at least the time it was given: the start rounds down and
 * the end rounds up, so a sub-minute boundary can never let the solver slip a
 * task into a moment the appointment actually occupies.
 */
function interval(startIso: string, endIso: string): string {
  return toRangeLiteral({ start: toInstant(startIso), end: toInstantCeil(endIso) });
}

/**
 * Translates the database's overlap refusal into the command layer's language.
 *
 * The exclusion constraint (§5.3) is the authority on appointment overlap, not
 * a check in application code — it holds against concurrent inserts, which a
 * read-then-write check does not. What is added here is only a sentence a user
 * can act on.
 */
async function insertingBlock<T>(action: () => Promise<T>, calendarId: string): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    if ((cause as { code?: unknown }).code === EXCLUSION_VIOLATION) {
      throw new PreconditionFailedError(
        `That time overlaps an existing appointment in calendar ${calendarId}`,
      );
    }
    throw error;
  }
}
