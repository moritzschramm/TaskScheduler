import { and, eq, inArray, isNull } from 'drizzle-orm';
import { notifications } from '../../db/schema/index.js';
import { updateWhere } from '../journal.js';
import type { CommandContext, HandlerOutcome } from '../context.js';
import type { MarkNotificationsReadParams } from '@ambitime/shared';

/**
 * Dismissing a signal (spec §11).
 *
 * Changes no schedule, so it re-derives nothing: the calendar list comes back
 * empty and the response carries no schedules. A command whose effect is
 * confined to the notification centre should not make a fortnight of placements
 * be recomputed to prove it.
 *
 * Only unread ones are touched, and RLS confines the update to rows the actor
 * may see anyway. Re-marking something already read would move its `read_at`
 * and, worse, journal a change that undo would then "restore" to a different
 * timestamp than the one it had.
 */
export async function markNotificationsRead(
  params: MarkNotificationsReadParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  await updateWhere(
    ctx,
    'notifications',
    and(
      eq(notifications.userId, ctx.actorId),
      inArray(notifications.id, params.notificationIds),
      isNull(notifications.readAt),
    )!,
    { readAt: ctx.nowIso },
  );

  return { calendarIds: [] };
}
