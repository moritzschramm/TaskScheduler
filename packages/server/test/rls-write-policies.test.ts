import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenantContext } from '../src/db/context.js';
import { appMeta, memberships, teamGroups, teamMemberships } from '../src/db/schema/index.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { captureSqlState, SQLSTATE } from './support/errors.js';
import {
  addMember,
  addTeamMember,
  addTeamToGroup,
  createGroup,
  createTeam,
  createWorkTenant,
  registerUser,
} from './support/fixtures.js';
import { resetDomainTables, setupTestDatabase } from './support/database.js';

/**
 * The write side of the tenant boundary, plus the two link tables that
 * rls-isolation.test.ts does not reach.
 *
 * Reads failing closed is only half of isolation: a policy set that filters
 * SELECT but lets an INSERT name any `tenant_id` would leak just as badly, in
 * the other direction.
 */
describe('write policies and link-table isolation', () => {
  let handle: DatabaseHandle;

  let alice: string;
  let bob: string;
  let outsider: string;
  let tenantA: string;
  let tenantB: string;
  let teamA: string;
  let teamB: string;
  let groupA: string;
  let groupB: string;

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
    outsider = (await registerUser(handle.db, { email: 'outsider@example.com' })).userId;

    tenantA = await createWorkTenant(handle.db, 'Tenant A');
    tenantB = await createWorkTenant(handle.db, 'Tenant B');
    await addMember(handle.db, tenantA, alice, 'owner');
    await addMember(handle.db, tenantB, bob, 'owner');

    teamA = await createTeam(handle.db, tenantA, 'Team A');
    teamB = await createTeam(handle.db, tenantB, 'Team B');
    groupA = await createGroup(handle.db, tenantA, 'Group A');
    groupB = await createGroup(handle.db, tenantB, 'Group B');

    await addTeamToGroup(handle.db, tenantA, teamA, groupA);
    await addTeamToGroup(handle.db, tenantB, teamB, groupB);
    await addTeamMember(handle.db, tenantA, teamA, alice);
    await addTeamMember(handle.db, tenantB, teamB, bob);
  });

  describe('team_groups', () => {
    it('shows only the active tenant’s links', async () => {
      const rows = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
        tx.select({ teamId: teamGroups.teamId, groupId: teamGroups.groupId }).from(teamGroups),
      );

      expect(rows).toEqual([{ teamId: teamA, groupId: groupA }]);
    });

    it('refuses to write a link tagged with another tenant', async () => {
      const state = await captureSqlState(() =>
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
          tx.insert(teamGroups).values({ tenantId: tenantB, teamId: teamB, groupId: groupB }),
        ),
      );

      expect(state).toBe(SQLSTATE.insufficientPrivilege);
    });

    it('cannot delete another tenant’s link', async () => {
      await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
        const result = await tx.delete(teamGroups).where(eq(teamGroups.teamId, teamB));
        expect(result.count).toBe(0);
      });

      const survivors = await handle.db
        .select({ teamId: teamGroups.teamId })
        .from(teamGroups)
        .where(eq(teamGroups.tenantId, tenantB));
      expect(survivors).toHaveLength(1);
    });
  });

  describe('team_memberships', () => {
    it('shows only the active tenant’s rows', async () => {
      const rows = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
        tx.select({ userId: teamMemberships.userId }).from(teamMemberships),
      );

      expect(rows.map((r) => r.userId)).toEqual([alice]);
    });

    it('refuses to add someone to a team in another tenant', async () => {
      const state = await captureSqlState(() =>
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
          tx.insert(teamMemberships).values({ tenantId: tenantB, teamId: teamB, userId: bob }),
        ),
      );

      expect(state).toBe(SQLSTATE.insufficientPrivilege);
    });

    it('allows adding a tenant member to a team in the active tenant', async () => {
      await addMember(handle.db, tenantA, outsider);

      await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
        tx.insert(teamMemberships).values({ tenantId: tenantA, teamId: teamA, userId: outsider }),
      );

      const rows = await handle.db
        .select({ userId: teamMemberships.userId })
        .from(teamMemberships)
        .where(eq(teamMemberships.teamId, teamA));
      expect(rows.map((r) => r.userId).sort()).toEqual([alice, outsider].sort());
    });
  });

  describe('memberships', () => {
    it('allows a member to add someone to the active tenant', async () => {
      // The boundary enforced here is membership of the active tenant.
      // Restricting this to owner/admin is application-layer RBAC and arrives
      // with the auth provider in M8 (spec §10.2).
      await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
        tx.insert(memberships).values({ tenantId: tenantA, userId: outsider, role: 'member' }),
      );

      const rows = await handle.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.tenantId, tenantA));
      expect(rows.map((r) => r.userId).sort()).toEqual([alice, outsider].sort());
    });

    it('refuses to grant someone access to another tenant', async () => {
      const state = await captureSqlState(() =>
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
          tx.insert(memberships).values({ tenantId: tenantB, userId: alice, role: 'owner' }),
        ),
      );

      expect(state).toBe(SQLSTATE.insufficientPrivilege);
    });

    it('cannot change a role in another tenant', async () => {
      await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
        const result = await tx
          .update(memberships)
          .set({ role: 'member' })
          .where(and(eq(memberships.tenantId, tenantB), eq(memberships.userId, bob)));
        expect(result.count).toBe(0);
      });

      const [row] = await handle.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantB), eq(memberships.userId, bob)));
      expect(row?.role).toBe('owner');
    });

    it('cannot revoke a membership in another tenant', async () => {
      await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
        const result = await tx.delete(memberships).where(eq(memberships.tenantId, tenantB));
        expect(result.count).toBe(0);
      });

      const survivors = await handle.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.tenantId, tenantB));
      expect(survivors).toHaveLength(1);
    });

    it('cannot revoke a membership visible only because it is the caller’s own', async () => {
      // Alice can *see* her personal-tenant membership from tenant A's context,
      // because the SELECT policy spans tenants for her own rows. The write
      // policies do not, and that asymmetry is deliberate.
      const [personal] = await handle.db
        .select({ id: memberships.id, tenantId: memberships.tenantId })
        .from(memberships)
        .where(and(eq(memberships.userId, alice), sql`${memberships.tenantId} <> ${tenantA}`));

      await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
        const result = await tx.delete(memberships).where(eq(memberships.id, personal!.id));
        expect(result.count).toBe(0);
      });

      const still = await handle.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.id, personal!.id));
      expect(still).toHaveLength(1);
    });
  });

  describe('app_meta', () => {
    it('is readable by the application role', async () => {
      const rows = await withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
        tx.select({ key: appMeta.key }).from(appMeta),
      );

      expect(rows.map((r) => r.key)).toContain('schema_version');
    });

    it('is not writable by the application role', async () => {
      // Migration-owned configuration. The write privileges are revoked
      // outright, so this fails loudly rather than silently matching zero rows
      // the way a missing policy alone would.
      const state = await captureSqlState(() =>
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
          tx.update(appMeta).set({ value: 'tampered' }).where(eq(appMeta.key, 'schema_version')),
        ),
      );

      expect(state).toBe(SQLSTATE.insufficientPrivilege);
    });
  });
});
