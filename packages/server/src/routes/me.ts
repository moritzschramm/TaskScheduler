import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { memberships, tenants, users } from '../db/schema/index.js';
import { requireContext } from '../auth/middleware.js';
import { withRequestContext } from '../auth/context.js';
import type { AppEnv } from '../app.js';
import type { Auth } from '../auth/auth.js';

/**
 * Who the caller is, and where they are acting (spec §9.3).
 *
 * The one route M8 adds, and it earns its place twice over: it is what a client
 * needs before it can render anything — the active context and the list to
 * switch between — and it is the thing that demonstrates the session actually
 * reaches the database as a tenant context rather than merely being verified at
 * the door.
 *
 * Every field below is read **inside** the tenant context, under `ambitime_app`
 * and subject to RLS. Nothing is taken from the session object beyond the ids
 * used to open that context, so what comes back is what the policies allow,
 * not what the caller claimed.
 */
export function meRoute(auth: Auth) {
  return new Hono<AppEnv>().get('/me', requireContext(auth), async (c) => {
    const context = c.get('context');

    const body = await withRequestContext(c.get('db'), context, async (tx) => {
      const [user] = await tx
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, context.userId))
        .limit(1);

      // Every tenant this user belongs to, not only the active one — §9.3's
      // context switcher reads exactly this, and the RLS policy on memberships
      // is written to allow it.
      const contexts = await tx
        .select({
          tenantId: tenants.id,
          name: tenants.name,
          slug: tenants.slug,
          role: memberships.role,
          isPersonal: tenants.personalOwnerId,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(eq(memberships.userId, context.userId))
        .orderBy(tenants.slug);

      return {
        user,
        activeTenantId: context.tenantId,
        contexts: contexts.map((row) => ({
          tenantId: row.tenantId,
          name: row.name,
          slug: row.slug,
          role: row.role,
          isPersonal: row.isPersonal === context.userId,
        })),
      };
    });

    return c.json(body);
  });
}
