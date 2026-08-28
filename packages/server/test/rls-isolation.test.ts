import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantAccessError, withTenantContext } from '../src/db/context.js';
import { groups, teams } from '../src/db/schema/index.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { captureSqlState, SQLSTATE } from './support/errors.js';
import {
  addMember,
  createGroup,
  createTeam,
  createWorkTenant,
  registerUser,
} from './support/fixtures.js';
import { resetDomainTables, setupTestDatabase } from './support/database.js';

describe('tenant isolation (RLS)', () => {
  let handle: DatabaseHandle;

  // Alice belongs to tenant A only; Bob to tenant B only; Carol to both.
  let alice: string;
  let bob: string;
  let carol: string;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);

    alice = (await registerUser(handle.db, { email: 'alice@example.com' })).userId;
    bob = (await registerUser(handle.db, { email: 'bob@example.com' })).userId;
    carol = (await registerUser(handle.db, { email: 'carol@example.com' })).userId;

    tenantA = await createWorkTenant(handle.db, 'Tenant A');
    tenantB = await createWorkTenant(handle.db, 'Tenant B');

    await addMember(handle.db, tenantA, alice, 'owner');
    await addMember(handle.db, tenantB, bob, 'owner');
    await addMember(handle.db, tenantA, carol);
    await addMember(handle.db, tenantB, carol);

    await createTeam(handle.db, tenantA, 'Team A');
    await createTeam(handle.db, tenantB, 'Team B');
    await createGroup(handle.db, tenantA, 'Group A');
    await createGroup(handle.db, tenantB, 'Group B');
  });

  it('reads rows belonging to the active tenant', async () => {
    const rows = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
      tx.select({ name: teams.name }).from(teams),
    );

    expect(rows.map((r) => r.name)).toEqual(['Team A']);
  });

  it('cannot read another tenant’s rows', async () => {
    const rows = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
      tx
        .select({ name: teams.name })
        .from(teams)
        .where(sql`${teams.name} = 'Team B'`),
    );

    // Not an authorisation error — the row simply does not exist for this
    // context. That is the property that makes RLS safe against query bugs.
    expect(rows).toEqual([]);
  });

  it('shows a multi-tenant user only the context they are acting in', async () => {
    const inA = await withTenantContext(handle.db, { userId: carol, tenantId: tenantA }, (tx) =>
      tx.select({ name: groups.name }).from(groups),
    );
    const inB = await withTenantContext(handle.db, { userId: carol, tenantId: tenantB }, (tx) =>
      tx.select({ name: groups.name }).from(groups),
    );

    expect(inA.map((r) => r.name)).toEqual(['Group A']);
    expect(inB.map((r) => r.name)).toEqual(['Group B']);
  });

  it('refuses a context the user holds no membership in', async () => {
    await expect(
      withTenantContext(handle.db, { userId: alice, tenantId: tenantB }, (tx) =>
        tx.select().from(teams),
      ),
    ).rejects.toThrow(TenantAccessError);
  });

  it('cannot write a row into another tenant', async () => {
    const state = await captureSqlState(() =>
      withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
        tx.insert(teams).values({ tenantId: tenantB, name: 'Smuggled' }),
      ),
    );
    expect(state).toBe(SQLSTATE.insufficientPrivilege);

    const leaked = await handle.db
      .select({ name: teams.name })
      .from(teams)
      .where(sql`${teams.name} = 'Smuggled'`);
    expect(leaked).toEqual([]);
  });

  it('cannot update a row in another tenant', async () => {
    await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
      const result = await tx
        .update(teams)
        .set({ name: 'Renamed by A' })
        .where(sql`${teams.name} = 'Team B'`);
      // The row is invisible, so the UPDATE matches nothing rather than failing.
      expect(result.count).toBe(0);
    });

    const untouched = await handle.db
      .select({ name: teams.name })
      .from(teams)
      .where(sql`${teams.tenantId} = ${tenantB}`);
    expect(untouched.map((r) => r.name)).toEqual(['Team B']);
  });

  it('cannot delete a row in another tenant', async () => {
    await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
      const result = await tx.delete(teams).where(sql`${teams.name} = 'Team B'`);
      expect(result.count).toBe(0);
    });

    const survivors = await handle.db.select({ name: teams.name }).from(teams);
    expect(survivors.map((r) => r.name).sort()).toEqual(['Team A', 'Team B']);
  });

  it('sees nothing when the app role is active but no tenant context is set', async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'ambitime_app', true)`);
      return tx.select({ name: teams.name }).from(teams);
    });

    // Deny by default: current_setting(..., true) is NULL, so every policy
    // predicate is NULL, so nothing matches.
    expect(rows).toEqual([]);
  });

  it('unwinds role and context when the transaction ends', async () => {
    await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
      const [inside] = await tx.execute<{ role: string; tenant: string | null }>(
        sql`select current_user as role, current_setting('app.tenant_id', true) as tenant`,
      );
      expect(inside?.role).toBe('ambitime_app');
      expect(inside?.tenant).toBe(tenantA);
    });

    // SET LOCAL semantics: a pooled connection must not carry one request's
    // context into the next.
    //
    // Postgres resets a custom GUC that was set during the session to the empty
    // string rather than to undefined — which is exactly why the accessor
    // functions wrap it in `nullif(..., '')`. Assert the property that matters
    // rather than the representation: a later app-role query sees nothing.
    const [after] = await handle.db.execute<{ role: string; tenant: string | null }>(
      sql`select current_user as role, current_setting('app.tenant_id', true) as tenant`,
    );
    expect(after?.role).toBe('ambitime');
    expect(after?.tenant ?? '').toBe('');

    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'ambitime_app', true)`);
      return tx.select({ name: teams.name }).from(teams);
    });
    expect(rows).toEqual([]);
  });
});
