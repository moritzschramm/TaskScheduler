import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemPrivileges, withTenantContext } from '../src/db/context.js';
import {
  emailIdentities,
  memberships,
  teamGroups,
  teamMemberships,
  tenants,
  users,
} from '../src/db/schema/index.js';
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

describe('identity and tenancy constraints', () => {
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

  describe('personal tenant bootstrap', () => {
    it('creates a personal tenant with an owner membership for every new user', async () => {
      const { userId, personalTenantId } = await registerUser(handle.db, {
        email: 'dana@example.com',
        displayName: 'Dana',
      });

      const [tenant] = await handle.db
        .select({ personalOwnerId: tenants.personalOwnerId })
        .from(tenants)
        .where(eq(tenants.id, personalTenantId));
      expect(tenant?.personalOwnerId).toBe(userId);

      const [membership] = await handle.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(eq(memberships.tenantId, personalTenantId));
      expect(membership?.role).toBe('owner');
    });

    it('creates the personal tenant even for a raw insert that bypasses registerUser', async () => {
      // The invariant has to survive Better Auth writing `users` directly (M8),
      // which is why it lives in a trigger rather than in application code.
      const userId = await withSystemPrivileges(handle.db, async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({ displayName: 'Raw insert', email: 'raw-insert@example.test' })
          .returning({ id: users.id });
        return row!.id;
      });

      const owned = await handle.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.personalOwnerId, userId));
      expect(owned).toHaveLength(1);
    });

    it('permits at most one personal tenant per user', async () => {
      const { userId } = await registerUser(handle.db, { email: 'eve@example.com' });

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.insert(tenants).values({ name: 'second personal', personalOwnerId: userId }),
        ),
      );
      expect(state).toBe(SQLSTATE.uniqueViolation);
    });
  });

  describe('email identities', () => {
    it('matches addresses case-insensitively', async () => {
      await registerUser(handle.db, { email: 'Frank@Example.com' });

      const state = await captureSqlState(() =>
        registerUser(handle.db, { email: 'frank@example.com' }),
      );
      expect(state).toBe(SQLSTATE.uniqueViolation);
    });

    it('allows one user to hold several addresses', async () => {
      const { userId } = await registerUser(handle.db, { email: 'grace@work.example' });

      await withSystemPrivileges(handle.db, (tx) =>
        tx.insert(emailIdentities).values({ userId, email: 'grace@home.example' }),
      );

      const rows = await handle.db
        .select({ email: emailIdentities.email })
        .from(emailIdentities)
        .where(eq(emailIdentities.userId, userId));
      expect(rows).toHaveLength(2);
    });

    it('rejects a second primary address', async () => {
      const { userId } = await registerUser(handle.db, { email: 'heidi@example.com' });

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx
            .insert(emailIdentities)
            .values({ userId, email: 'heidi2@example.com', isPrimary: true }),
        ),
      );
      expect(state).toBe(SQLSTATE.uniqueViolation);
    });

    it('rejects leaving a user with no primary address', async () => {
      const { userId } = await registerUser(handle.db, { email: 'ivan@example.com' });

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx
            .update(emailIdentities)
            .set({ isPrimary: false })
            .where(eq(emailIdentities.userId, userId)),
        ),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('allows promoting a different address within one transaction', async () => {
      // The deferred trigger exists for exactly this: the intermediate state has
      // zero primaries, which is fine as long as the commit is consistent.
      const { userId } = await registerUser(handle.db, { email: 'judy@old.example' });

      await withSystemPrivileges(handle.db, async (tx) => {
        await tx.insert(emailIdentities).values({ userId, email: 'judy@new.example' });
        await tx
          .update(emailIdentities)
          .set({ isPrimary: false })
          .where(eq(emailIdentities.email, 'judy@old.example'));
        await tx
          .update(emailIdentities)
          .set({ isPrimary: true })
          .where(eq(emailIdentities.email, 'judy@new.example'));
      });

      const [primary] = await handle.db
        .select({ email: emailIdentities.email })
        .from(emailIdentities)
        .where(sql`${emailIdentities.userId} = ${userId} and ${emailIdentities.isPrimary}`);
      expect(primary?.email).toBe('judy@new.example');
    });
  });

  describe('membership cardinality', () => {
    it('lets a user belong to several tenants and several teams and groups', async () => {
      const { userId } = await registerUser(handle.db, { email: 'karl@example.com' });
      const tenantA = await createWorkTenant(handle.db, 'A');
      const tenantB = await createWorkTenant(handle.db, 'B');
      await addMember(handle.db, tenantA, userId);
      await addMember(handle.db, tenantB, userId);

      const teamOne = await createTeam(handle.db, tenantA, 'One');
      const teamTwo = await createTeam(handle.db, tenantA, 'Two');
      await addTeamMember(handle.db, tenantA, teamOne, userId);
      await addTeamMember(handle.db, tenantA, teamTwo, userId);

      // A team belongs to zero-or-more groups; a group holds many teams.
      const groupX = await createGroup(handle.db, tenantA, 'X');
      const groupY = await createGroup(handle.db, tenantA, 'Y');
      await addTeamToGroup(handle.db, tenantA, teamOne, groupX);
      await addTeamToGroup(handle.db, tenantA, teamOne, groupY);
      await addTeamToGroup(handle.db, tenantA, teamTwo, groupX);

      const tenantCount = await handle.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, userId));
      // Two work tenants plus the personal tenant created at registration.
      expect(tenantCount).toHaveLength(3);

      const teamCount = await handle.db
        .select({ id: teamMemberships.id })
        .from(teamMemberships)
        .where(eq(teamMemberships.userId, userId));
      expect(teamCount).toHaveLength(2);

      const links = await handle.db.select({ teamId: teamGroups.teamId }).from(teamGroups);
      expect(links).toHaveLength(3);
    });

    it('rejects a duplicate membership in the same tenant', async () => {
      const { userId } = await registerUser(handle.db, { email: 'lena@example.com' });
      const tenantId = await createWorkTenant(handle.db, 'Dup');
      await addMember(handle.db, tenantId, userId);

      const state = await captureSqlState(() => addMember(handle.db, tenantId, userId));
      expect(state).toBe(SQLSTATE.uniqueViolation);
    });

    it('rejects team membership without tenant membership', async () => {
      const { userId } = await registerUser(handle.db, { email: 'mo@example.com' });
      const tenantId = await createWorkTenant(handle.db, 'Closed');
      const teamId = await createTeam(handle.db, tenantId, 'Inner');

      // No membership row for this user in this tenant.
      const state = await captureSqlState(() => addTeamMember(handle.db, tenantId, teamId, userId));
      expect(state).toBe(SQLSTATE.foreignKeyViolation);
    });

    it('removes team memberships when the tenant membership is revoked', async () => {
      const { userId } = await registerUser(handle.db, { email: 'nina@example.com' });
      const tenantId = await createWorkTenant(handle.db, 'Cascade');
      await addMember(handle.db, tenantId, userId);
      const teamId = await createTeam(handle.db, tenantId, 'Squad');
      await addTeamMember(handle.db, tenantId, teamId, userId);

      await withSystemPrivileges(handle.db, (tx) =>
        tx
          .delete(memberships)
          .where(sql`${memberships.tenantId} = ${tenantId} and ${memberships.userId} = ${userId}`),
      );

      const remaining = await handle.db
        .select({ id: teamMemberships.id })
        .from(teamMemberships)
        .where(eq(teamMemberships.userId, userId));
      expect(remaining).toEqual([]);
    });
  });

  describe('cross-tenant references', () => {
    it('rejects linking a team to a group in another tenant', async () => {
      const tenantA = await createWorkTenant(handle.db, 'A');
      const tenantB = await createWorkTenant(handle.db, 'B');
      const teamInA = await createTeam(handle.db, tenantA, 'Team A');
      const groupInB = await createGroup(handle.db, tenantB, 'Group B');

      // Composite foreign keys pin both sides to the row's own tenant_id, so
      // there is no combination of ids that produces a cross-tenant link.
      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.insert(teamGroups).values({ tenantId: tenantA, teamId: teamInA, groupId: groupInB }),
        ),
      );
      expect(state).toBe(SQLSTATE.foreignKeyViolation);
    });

    it('rejects a team membership pointing at a team in another tenant', async () => {
      const { userId } = await registerUser(handle.db, { email: 'olga@example.com' });
      const tenantA = await createWorkTenant(handle.db, 'A');
      const tenantB = await createWorkTenant(handle.db, 'B');
      await addMember(handle.db, tenantA, userId);
      const teamInB = await createTeam(handle.db, tenantB, 'Team B');

      const state = await captureSqlState(() => addTeamMember(handle.db, tenantA, teamInB, userId));
      expect(state).toBe(SQLSTATE.foreignKeyViolation);
    });
  });

  describe('optimistic locking', () => {
    it('increments version and updated_at on a real change', async () => {
      const tenantId = await createWorkTenant(handle.db, 'Versioned');
      const { userId } = await registerUser(handle.db, { email: 'pia@example.com' });
      await addMember(handle.db, tenantId, userId);

      const [before] = await handle.db
        .select({ version: tenants.version, updatedAt: tenants.updatedAt })
        .from(tenants)
        .where(eq(tenants.id, tenantId));

      await withTenantContext(handle.db, { userId, tenantId }, (tx) =>
        tx.update(tenants).set({ name: 'Renamed' }).where(eq(tenants.id, tenantId)),
      );

      const [after] = await handle.db
        .select({ version: tenants.version, updatedAt: tenants.updatedAt })
        .from(tenants)
        .where(eq(tenants.id, tenantId));

      expect(after?.version).toBe((before?.version ?? 0) + 1);
      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
    });

    it('ignores a version supplied by the caller', async () => {
      // Commands check the expected version in their WHERE clause; they must not
      // be able to choose the next one.
      const tenantId = await createWorkTenant(handle.db, 'Forge');

      await withSystemPrivileges(handle.db, (tx) =>
        tx.update(tenants).set({ name: 'Changed', version: 999 }).where(eq(tenants.id, tenantId)),
      );

      const [row] = await handle.db
        .select({ version: tenants.version })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      expect(row?.version).toBe(2);
    });

    it('does not consume a version on a no-op update', async () => {
      const tenantId = await createWorkTenant(handle.db, 'Idle');

      await withSystemPrivileges(handle.db, (tx) =>
        tx.update(tenants).set({ name: 'Idle' }).where(eq(tenants.id, tenantId)),
      );

      const [row] = await handle.db
        .select({ version: tenants.version })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      expect(row?.version).toBe(1);
    });
  });
});
