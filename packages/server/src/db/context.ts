import { and, eq, sql } from 'drizzle-orm';
import { memberships } from './schema/index.js';
import type { Database, Transaction } from './client.js';

/** The non-superuser role every tenant-scoped statement runs as (migration 0002). */
export const APP_ROLE = 'ambitime_app';

export interface TenantContext {
  userId: string;
  tenantId: string;
}

/** Raised when a user asks to act in a tenant they hold no membership in. */
export class TenantAccessError extends Error {
  constructor(
    readonly userId: string,
    readonly tenantId: string,
  ) {
    super(`User ${userId} is not a member of tenant ${tenantId}`);
    this.name = 'TenantAccessError';
  }
}

/**
 * Runs `callback` inside a transaction scoped to one tenant context.
 *
 * This is the normal path for every request. Three things happen before the
 * callback, and the order matters:
 *
 *  1. Membership is verified while still privileged. RLS answers "what may this
 *     context see"; it cannot answer "is this context legitimate", because the
 *     context is exactly what an attacker would forge. So the check happens
 *     here, above the policies.
 *  2. `app.user_id` and `app.tenant_id` are set, keying every policy.
 *  3. The session switches to `ambitime_app`, which — unlike the owner — is not
 *     a superuser and is therefore actually subject to those policies.
 *
 * All three use `SET LOCAL` semantics (`set_config(..., true)`), so they unwind
 * with the transaction. That is what makes this safe over a connection pool: a
 * pooled connection can never carry one user's context into another's request.
 *
 * `set_config` rather than `SET ROLE`/`SET` because the latter cannot take
 * parameters, and building that SQL by interpolation is how injection happens.
 */
export async function withTenantContext<T>(
  db: Database,
  context: TenantContext,
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(eq(memberships.tenantId, context.tenantId), eq(memberships.userId, context.userId)),
      )
      .limit(1);

    if (!membership) {
      throw new TenantAccessError(context.userId, context.tenantId);
    }

    await tx.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
    await tx.execute(sql`select set_config('app.tenant_id', ${context.tenantId}, true)`);
    await tx.execute(sql`select set_config('role', ${APP_ROLE}, true)`);

    return callback(tx);
  });
}

/**
 * Runs `callback` with the owner role and **no tenant context** — RLS policies
 * are attached `TO ambitime_app`, so nothing here is filtered.
 *
 * Reserved for operations that genuinely cannot be tenant-scoped, because no
 * legitimate context exists yet: registering a user, creating a tenant,
 * migrations. Everything else belongs in `withTenantContext`.
 *
 * Named to be conspicuous in review and in a diff. If you are reaching for it
 * to make a query work, the query is probably missing its context.
 */
export async function withSystemPrivileges<T>(
  db: Database,
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(callback);
}
