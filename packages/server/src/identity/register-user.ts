import { eq } from 'drizzle-orm';
import { withSystemPrivileges } from '../db/context.js';
import { emailIdentities, tenants, users } from '../db/schema/index.js';
import type { Database } from '../db/client.js';

export interface RegisterUserInput {
  email: string;
  displayName?: string | undefined;
}

export interface RegisteredUser {
  userId: string;
  personalTenantId: string;
}

/**
 * Creates a global principal with its primary email address and returns the
 * personal tenant that came with it.
 *
 * Registration runs on the system path by necessity: there is no tenant to act
 * in until this call has produced one (spec §4.2).
 *
 * The personal tenant and its `owner` membership are *not* created here — the
 * `create_personal_tenant` trigger does that, so the invariant survives code
 * paths this function knows nothing about, including Better Auth writing
 * `users` directly from M8. This function only reads back what the trigger made.
 */
export async function registerUser(
  db: Database,
  input: RegisterUserInput,
): Promise<RegisteredUser> {
  return withSystemPrivileges(db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ displayName: input.displayName ?? null })
      .returning({ id: users.id });

    if (!user) throw new Error('Failed to create user');

    await tx.insert(emailIdentities).values({
      userId: user.id,
      // Addresses are matched case-insensitively; normalise on the way in so
      // stored data agrees with the unique index on lower(email).
      email: input.email.trim().toLowerCase(),
      isPrimary: true,
    });

    const [personalTenant] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.personalOwnerId, user.id))
      .limit(1);

    if (!personalTenant) {
      throw new Error(
        `Personal tenant was not created for user ${user.id} — is the create_personal_tenant trigger installed?`,
      );
    }

    return { userId: user.id, personalTenantId: personalTenant.id };
  });
}
