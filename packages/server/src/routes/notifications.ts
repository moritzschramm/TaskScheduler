import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { notifications } from '../db/schema/index.js';
import { requireContext } from '../auth/middleware.js';
import { withRequestContext } from '../auth/context.js';
import type { AppEnv } from '../app.js';
import type { Auth } from '../auth/auth.js';

/**
 * The user's notifications (spec §11).
 *
 * A read over the table, nothing more. **Delivery** — in-app when online,
 * email when offline, driven by pg-boss — is M15's, and **producing** them from
 * the diagnostics a re-derive turns up is M13's. This endpoint is the seam
 * between them, so both arrive without the client's data flow changing.
 *
 * Scoped to the signed-in user rather than the tenant: a notification is
 * addressed to a person. The RLS policy says the same thing, and this is the
 * predicate that lets the index on `(user_id, read_at)` do its job.
 */
export function notificationRoutes(auth: Auth) {
  return new Hono<AppEnv>().get('/notifications', requireContext(auth), async (c) => {
    const context = c.get('context');

    const rows = await withRequestContext(c.get('db'), context, (tx) =>
      tx
        .select({
          id: notifications.id,
          type: notifications.type,
          severity: notifications.severity,
          payload: notifications.payload,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(eq(notifications.userId, context.userId))
        .orderBy(desc(notifications.createdAt))
        .limit(100),
    );

    return c.json({ notifications: rows }, 200);
  });
}
