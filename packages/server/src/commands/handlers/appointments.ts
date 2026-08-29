import { lockAppointment, type CommandContext, type HandlerOutcome } from '../context.js';
import { requireCalendar } from '../entities.js';
import { insertRow, updateRow } from '../journal.js';
import { PreconditionFailedError } from '../errors.js';
import { toInstant, toInstantCeil, toRangeLiteral } from '../../schedule/instants.js';
import type {
  AddAppointmentParams,
  AddUnavailabilityParams,
  EditAppointmentParams,
} from '@ambitime/shared';
import type { NewAppointment } from '../../db/schema/index.js';

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
  const { patch } = params;
  const values: Partial<NewAppointment> = {};

  if (patch.title !== undefined) values.title = patch.title;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.interval !== undefined) {
    values.during = interval(patch.interval.start, patch.interval.end);
  }

  await insertingBlock(
    () => updateRow(ctx, 'appointments', appointment.id, values),
    appointment.calendarId,
  );

  return { calendarIds: [appointment.calendarId] };
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
