import { eq } from 'drizzle-orm';
import { withSystemPrivileges } from '../db/context.js';
import { tenants, users } from '../db/schema/index.js';
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
 * **Not the sign-up path.** Since M8 that is Better Auth's (§10.1), which
 * writes this same table and gets the same triggers. What survives here is the
 * *system* registration a fixture, an import or an admin tool needs — one that
 * makes a principal without a credential to sign in with.
 *
 * Neither the personal tenant, its `owner` membership, nor the primary email
 * identity is created here. Three triggers do that, which is why both paths
 * produce identical users: the invariants belong to the database, not to
 * whichever function happened to insert the row.
 */
export async function registerUser(
  db: Database,
  input: RegisterUserInput,
): Promise<RegisteredUser> {
  return withSystemPrivileges(db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        displayName: input.displayName ?? null,
        // Addresses are matched case-insensitively; normalise on the way in so
        // stored data agrees with the unique index on lower(email).
        email: input.email.trim().toLowerCase(),
      })
      .returning({ id: users.id });

    if (!user) throw new Error('Failed to create user');

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
