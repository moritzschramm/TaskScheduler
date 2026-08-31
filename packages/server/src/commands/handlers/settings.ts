import { eq } from 'drizzle-orm';
import { users } from '../../db/schema/index.js';
import { updateWhere } from '../journal.js';
import type { CommandContext, HandlerOutcome } from '../context.js';
import type { UpdateSettingsParams } from '@ambitime/shared';

/**
 * The user settings of spec §13.
 *
 * Re-derives nothing, deliberately. Locale, timezone and first-day-of-week
 * change how a schedule is *read*, never what it is — the derived cache is a
 * function of source state (§3.4), and a viewer's preferences are not source
 * state. Two members of one tenant must not be able to make the same calendar
 * report different placements.
 *
 * Journalled, so undo works: settings are exactly the kind of thing somebody
 * changes, dislikes and wants back.
 */
export async function updateSettings(
  params: UpdateSettingsParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const { patch } = params;
  const values: Record<string, unknown> = {};

  // `null` clears the setting back to unset, which means "follow the calendar"
  // rather than "use a default" — what the user had before they opened this
  // screen at all.
  if (patch.locale !== undefined) values['locale'] = patch.locale;
  if (patch.timeZone !== undefined) values['timeZone'] = patch.timeZone;
  if (patch.firstDayOfWeek !== undefined) values['firstDayOfWeek'] = patch.firstDayOfWeek;

  if (Object.keys(values).length > 0) {
    await updateWhere(ctx, 'users', eq(users.id, ctx.actorId), values);
  }

  return { calendarIds: [] };
}
