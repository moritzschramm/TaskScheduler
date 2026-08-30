import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { notifications } from '../db/schema/index.js';
import { requireContext } from '../auth/middleware.js';
import { withRequestContext } from '../auth/context.js';
import { recordHeartbeat } from '../notifications/deliver.js';
import { isoOrNull } from '../api/present.js';
import type { AppEnv } from '../app.js';
import type { Auth } from '../auth/auth.js';
import type { Clock } from '../app.js';

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
export function notificationRoutes(auth: Auth, clock: Clock = () => new Date()) {
  return (
    new Hono<AppEnv>()
      /**
       * The presence heartbeat (spec §11).
       *
       * A plain write, not a command: it records that a browser is open, takes no
       * decision, and a log of it would be a log of somebody existing. It is what
       * decides whether the next notification arrives in the app or by email.
       */
      .post('/presence', requireContext(auth), async (c) => {
        const context = c.get('context');
        await recordHeartbeat(c.get('db'), context.userId, clock());
        return c.json({ ok: true } as const, 200);
      })

      .get('/notifications', requireContext(auth), async (c) => {
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

        // Normalised here, at the presentation boundary: these columns are
        // `mode: 'string'`, so the driver hands back Postgres's own
        // `2026-03-23 08:00:00+00` and the shared schema promises ISO-8601. The
        // same seam the task list needed.
        return c.json(
          {
            notifications: rows.map((row) => ({
              ...row,
              readAt: isoOrNull(row.readAt),
              createdAt: isoOrNull(row.createdAt)!,
            })),
          },
          200,
        );
      })
  );
}
