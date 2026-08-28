import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenantContext } from '../src/db/context.js';
import { emailIdentities, memberships, tenants, users } from '../src/db/schema/index.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { captureSqlState, SQLSTATE } from './support/errors.js';
import { addMember, createWorkTenant, registerUser } from './support/fixtures.js';
import { resetDomainTables, setupTestDatabase } from './support/database.js';

/**
 * `users` and `email_identities` are global, not tenant-scoped (spec §4.1), so
 * they are governed by a user boundary rather than by `tenant_id` — a second,
 * separate axis from the tenant isolation covered in rls-isolation.test.ts.
 */
describe('user boundary (RLS on global identity tables)', () => {
  let handle: DatabaseHandle;

  let alice: string;
  let bob: string;
  let carol: string;
  let tenantA: string;
  let alicePersonal: string;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);

    const aliceReg = await registerUser(handle.db, { email: 'alice@example.com' });
    alice = aliceReg.userId;
    alicePersonal = aliceReg.personalTenantId;
    bob = (await registerUser(handle.db, { email: 'bob@example.com' })).userId;
    carol = (await registerUser(handle.db, { email: 'carol@example.com' })).userId;

    // Alice and Carol share tenant A. Bob shares nothing with anyone.
    tenantA = await createWorkTenant(handle.db, 'Tenant A');
    await addMember(handle.db, tenantA, alice, 'owner');
    await addMember(handle.db, tenantA, carol);
  });

  it('shows a user themselves and the people they share the active tenant with', async () => {
    const visible = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
      tx.select({ id: users.id }).from(users),
    );

    expect(visible.map((r) => r.id).sort()).toEqual([alice, carol].sort());
  });

  it('hides users from an unrelated tenant', async () => {
    const visible = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.id} = ${bob}`),
    );

    expect(visible).toEqual([]);
  });

  it('shows only the acting user inside their personal tenant', async () => {
    // The personal tenant has exactly one member, so co-member visibility
    // collapses to the user themselves.
    const visible = await withTenantContext(
      handle.db,
      { userId: alice, tenantId: alicePersonal },
      (tx) => tx.select({ id: users.id }).from(users),
    );

    expect(visible.map((r) => r.id)).toEqual([alice]);
  });

  it('never exposes another user’s email address, even to a co-member', async () => {
    // Strictly narrower than `users`: addresses are personal data, so sharing a
    // tenant is not enough to see them.
    const visible = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
      tx.select({ email: emailIdentities.email }).from(emailIdentities),
    );

    expect(visible.map((r) => r.email)).toEqual(['alice@example.com']);
  });

  it('refuses to modify another user’s record', async () => {
    await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
      const result = await tx
        .update(users)
        .set({ displayName: 'Renamed by Alice' })
        .where(sql`${users.id} = ${carol}`);
      expect(result.count).toBe(0);
    });

    const [row] = await handle.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(sql`${users.id} = ${carol}`);
    expect(row?.displayName).toBeNull();
  });

  it('refuses to create a user on the tenant-scoped path', async () => {
    // Registration has no tenant to act in, so it must go through the system
    // path; the absence of an INSERT policy is what makes that non-optional.
    const state = await captureSqlState(() =>
      withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
        tx.insert(users).values({ displayName: 'Smuggled principal' }),
      ),
    );

    expect(state).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('lists every tenant the user belongs to, not only the active one', async () => {
    // What the context switcher reads (spec §9.3).
    const visible = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
      tx.select({ id: tenants.id }).from(tenants),
    );

    expect(visible.map((r) => r.id).sort()).toEqual([tenantA, alicePersonal].sort());
  });

  it('does not leak a co-member’s memberships in tenants they do not share', async () => {
    const carolPrivate = await createWorkTenant(handle.db, 'Carol only');
    await addMember(handle.db, carolPrivate, carol, 'owner');

    const visible = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
      tx.select({ tenantId: memberships.tenantId }).from(memberships),
    );

    const tenantIds = new Set(visible.map((r) => r.tenantId));
    expect(tenantIds.has(carolPrivate)).toBe(false);
    // Alice sees tenant A's memberships plus her own elsewhere (her personal one).
    expect(tenantIds.has(tenantA)).toBe(true);
    expect(tenantIds.has(alicePersonal)).toBe(true);
  });
});
