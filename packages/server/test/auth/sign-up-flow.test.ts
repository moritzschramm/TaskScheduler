import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailIdentities, memberships, tenants, users } from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../support/auth.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Sign-up and sign-in through Better Auth (spec §10.1).
 *
 * The interesting assertions are not "a user row appeared". They are that
 * signing up produced a *complete* principal — personal tenant, owner
 * membership, primary email identity — **without the sign-up code knowing any
 * of those exist**. M1 put those invariants in triggers precisely so they would
 * survive a code path written by somebody else, and this is that path.
 */
describe('sign-up and sign-in', () => {
  let handle: DatabaseHandle;
  let app: TestApp;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    app = createTestApp(handle.db);
  });

  it('creates a principal with everything the domain requires', async () => {
    const session = await app.signUp({ email: 'Ada@Example.test', name: 'Ada' });

    const [user] = await handle.db.select().from(users).where(eq(users.id, session.userId));
    expect(user).toMatchObject({ displayName: 'Ada', emailVerified: false });
    // Normalised on the way in, so it agrees with the case-insensitive index.
    expect(user?.email).toBe('ada@example.test');
    // Postgres minted it, not the library: §5.1 wants time-ordered keys.
    expect(user?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);

    const personal = await handle.db
      .select()
      .from(tenants)
      .where(eq(tenants.personalOwnerId, session.userId));
    expect(personal).toHaveLength(1);
    expect(personal[0]?.name).toBe('personal');
    // Derived from the user id, not their name or address: a slug goes in URLs,
    // and §14 keeps personal data out of those.
    expect(personal[0]?.slug).not.toContain('ada');

    const held = await handle.db
      .select({ role: memberships.role, tenantId: memberships.tenantId })
      .from(memberships)
      .where(eq(memberships.userId, session.userId));
    expect(held).toEqual([{ role: 'owner', tenantId: personal[0]!.id }]);

    const addresses = await handle.db
      .select({ email: emailIdentities.email, isPrimary: emailIdentities.isPrimary })
      .from(emailIdentities)
      .where(eq(emailIdentities.userId, session.userId));
    expect(addresses).toEqual([{ email: 'ada@example.test', isPrimary: true }]);
  });

  it('signs the same user back in', async () => {
    const created = await app.signUp({ email: 'ada@example.test' });
    const returned = await app.signIn({
      email: 'ada@example.test',
      password: TEST_PASSWORD,
    });

    expect(returned.userId).toBe(created.userId);
    expect(returned.cookie).not.toBe('');
  });

  it('refuses the wrong password', async () => {
    await app.signUp({ email: 'ada@example.test' });

    await expect(app.signIn({ email: 'ada@example.test', password: 'not-it' })).rejects.toThrow(
      /Auth request failed/,
    );
  });

  it('refuses a second account on the same address, whatever its case', async () => {
    await app.signUp({ email: 'ada@example.test' });

    await expect(app.signUp({ email: 'ADA@example.test' })).rejects.toThrow(/Auth request failed/);
  });

  it('keeps the login address and the primary identity as one address', async () => {
    // §4.1 wants many addresses per person and Better Auth wants exactly one on
    // the user. Both hold only if the two never disagree — in either direction.
    const session = await app.signUp({ email: 'ada@example.test' });

    await handle.db
      .update(users)
      .set({ email: 'ada.lovelace@example.test' })
      .where(eq(users.id, session.userId));

    const [mirrored] = await handle.db
      .select({ email: emailIdentities.email })
      .from(emailIdentities)
      .where(eq(emailIdentities.userId, session.userId));
    expect(mirrored?.email).toBe('ada.lovelace@example.test');

    await handle.db
      .update(emailIdentities)
      .set({ email: 'ada@example.test' })
      .where(eq(emailIdentities.userId, session.userId));

    const [back] = await handle.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, session.userId));
    expect(back?.email).toBe('ada@example.test');
  });

  it('turns a session away when there is none', async () => {
    const response = await app.app.request('/api/me');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });
});
