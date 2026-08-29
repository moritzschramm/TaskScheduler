import { eq } from 'drizzle-orm';
import { tenants } from '../db/schema/index.js';
import type { Auth } from './auth.js';
import type { Database, Transaction } from '../db/client.js';
import { withTenantContext } from '../db/context.js';

/**
 * Turning an authenticated session into a database context (spec §5.2, §10.1).
 *
 * This is the join the milestone exists to make. Until now `withTenantContext`
 * was handed a `{ userId, tenantId }` that a test made up; from here it is
 * handed one that came out of a signed session cookie, and **the request never
 * gets to say which tenant it is in**. The active tenant is a property of the
 * session row, set when the session was created and changed only through Better
 * Auth's own `set-active` endpoint — which checks membership before it writes.
 *
 * That is worth stating as a rule, because the alternative is so easy to reach
 * for: a tenant id in a header or a path parameter would be simpler, and would
 * mean every endpoint had to re-derive whether the caller was allowed to say it.
 */

export interface RequestContext {
  userId: string;
  /** The tenant this request acts in — RLS's `app.tenant_id`. */
  tenantId: string;
  sessionId: string;
}

/** Raised when a request arrives with no session, or with an expired one. */
export class UnauthenticatedError extends Error {
  constructor(message = 'Not signed in') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Resolves the session behind a request into the context its queries run under.
 *
 * The active organization is normally already on the session — a database hook
 * puts the personal tenant there when the session is created (§4.2). The
 * fallback covers the cases where it is not: a session that predates the hook,
 * or one whose active tenant has since been deleted and the foreign key set to
 * NULL. Falling back to the personal tenant is safe in a way that falling back
 * to "the first membership" would not be, because the personal tenant is the
 * one the user is guaranteed to own.
 */
export async function resolveRequestContext(
  auth: Auth,
  db: Database,
  headers: Headers,
): Promise<RequestContext> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new UnauthenticatedError();

  const activeTenantId =
    session.session.activeOrganizationId ?? (await personalTenantId(db, session.user.id));

  if (!activeTenantId) {
    throw new UnauthenticatedError(`User ${session.user.id} has no tenant to act in`);
  }

  return {
    userId: session.user.id,
    tenantId: activeTenantId,
    sessionId: session.session.id,
  };
}

/**
 * Runs `callback` in the tenant context of an authenticated request.
 *
 * Membership is still verified inside `withTenantContext`, even though the
 * session's active organization was checked when it was set. Two reasons, and
 * the second is the one that matters: a membership can be revoked while a
 * session is alive, and a check that runs once at the start of a session is a
 * check that stops being true.
 */
export async function withRequestContext<T>(
  db: Database,
  context: RequestContext,
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTenantContext(db, { userId: context.userId, tenantId: context.tenantId }, callback);
}

async function personalTenantId(db: Database, userId: string): Promise<string | undefined> {
  const [personal] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.personalOwnerId, userId))
    .limit(1);

  return personal?.id;
}
