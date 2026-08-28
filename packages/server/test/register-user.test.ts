import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerUser } from '../src/identity/register-user.js';
import { emailIdentities, memberships, tenants, users } from '../src/db/schema/index.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { resetDomainTables, setupTestDatabase } from './support/database.js';

describe('registerUser', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
  });

  it('stores the address normalised and marked primary', async () => {
    // The unique index is on lower(email); normalising on the way in keeps the
    // stored value agreeing with what that index enforces.
    const { userId } = await registerUser(handle.db, { email: '  Yuki@Example.COM  ' });

    const [identity] = await handle.db
      .select({ email: emailIdentities.email, isPrimary: emailIdentities.isPrimary })
      .from(emailIdentities)
      .where(eq(emailIdentities.userId, userId));

    expect(identity).toEqual({ email: 'yuki@example.com', isPrimary: true });
  });

  it('records the display name when given', async () => {
    const { userId } = await registerUser(handle.db, {
      email: 'zoe@example.com',
      displayName: 'Zoe',
    });

    const [user] = await handle.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    expect(user?.displayName).toBe('Zoe');
  });

  it('leaves the display name null when omitted', async () => {
    const { userId } = await registerUser(handle.db, { email: 'anon@example.com' });

    const [user] = await handle.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    expect(user?.displayName).toBeNull();
  });

  it('returns the personal tenant the trigger created', async () => {
    const { userId, personalTenantId } = await registerUser(handle.db, {
      email: 'aki@example.com',
    });

    const [tenant] = await handle.db
      .select({ id: tenants.id, personalOwnerId: tenants.personalOwnerId })
      .from(tenants)
      .where(eq(tenants.personalOwnerId, userId));

    expect(tenant?.id).toBe(personalTenantId);
    expect(tenant?.personalOwnerId).toBe(userId);
  });

  it('rolls the whole registration back when the address is taken', async () => {
    await registerUser(handle.db, { email: 'taken@example.com' });
    const usersBefore = await handle.db.select({ id: users.id }).from(users);

    await expect(registerUser(handle.db, { email: 'TAKEN@example.com' })).rejects.toThrow();

    // No orphan principal, and no orphan personal tenant from the trigger.
    const usersAfter = await handle.db.select({ id: users.id }).from(users);
    expect(usersAfter).toHaveLength(usersBefore.length);

    const tenantCount = await handle.db.select({ id: tenants.id }).from(tenants);
    expect(tenantCount).toHaveLength(usersBefore.length);

    const membershipCount = await handle.db.select({ id: memberships.id }).from(memberships);
    expect(membershipCount).toHaveLength(usersBefore.length);
  });
});
