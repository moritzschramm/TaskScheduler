import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemPrivileges } from '../src/db/context.js';
import {
  emailIdentities,
  groups,
  memberships,
  teamGroups,
  teamMemberships,
  teams,
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

/**
 * What survives a deletion, and what does not.
 *
 * Cascades are easy to get subtly wrong — a missing one strands orphan rows, an
 * over-eager one destroys a shared tenant because one member left. Both are
 * cheap to assert now and expensive to discover once M2 hangs the scheduling
 * tables off these keys.
 */
describe('deletion cascades and lifecycle', () => {
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

  describe('deleting a user', () => {
    it('takes their email identities, personal tenant and memberships with them', async () => {
      const { userId, personalTenantId } = await registerUser(handle.db, {
        email: 'quinn@example.com',
      });
      const tenantId = await createWorkTenant(handle.db, 'Shared');
      await addMember(handle.db, tenantId, userId);
      const teamId = await createTeam(handle.db, tenantId, 'Squad');
      await addTeamMember(handle.db, tenantId, teamId, userId);

      await withSystemPrivileges(handle.db, (tx) => tx.delete(users).where(eq(users.id, userId)));

      expect(
        await handle.db.select().from(emailIdentities).where(eq(emailIdentities.userId, userId)),
      ).toEqual([]);
      expect(
        await handle.db.select().from(tenants).where(eq(tenants.id, personalTenantId)),
      ).toEqual([]);
      expect(
        await handle.db.select().from(memberships).where(eq(memberships.userId, userId)),
      ).toEqual([]);
      expect(
        await handle.db.select().from(teamMemberships).where(eq(teamMemberships.userId, userId)),
      ).toEqual([]);
    });

    it('leaves shared tenants and their teams standing', async () => {
      // Only the personal tenant belongs to the user. A work tenant outliving
      // any one member is the whole point of the distinction.
      const leaver = (await registerUser(handle.db, { email: 'rosa@example.com' })).userId;
      const stayer = (await registerUser(handle.db, { email: 'sven@example.com' })).userId;
      const tenantId = await createWorkTenant(handle.db, 'Shared');
      await addMember(handle.db, tenantId, leaver);
      await addMember(handle.db, tenantId, stayer, 'owner');
      const teamId = await createTeam(handle.db, tenantId, 'Squad');

      await withSystemPrivileges(handle.db, (tx) => tx.delete(users).where(eq(users.id, leaver)));

      expect(await handle.db.select().from(tenants).where(eq(tenants.id, tenantId))).toHaveLength(
        1,
      );
      expect(await handle.db.select().from(teams).where(eq(teams.id, teamId))).toHaveLength(1);
      expect(
        await handle.db.select().from(memberships).where(eq(memberships.userId, stayer)),
      ).toHaveLength(2);
    });
  });

  describe('deleting a tenant', () => {
    it('removes everything scoped to it', async () => {
      const { userId } = await registerUser(handle.db, { email: 'tina@example.com' });
      const tenantId = await createWorkTenant(handle.db, 'Doomed');
      await addMember(handle.db, tenantId, userId);
      const teamId = await createTeam(handle.db, tenantId, 'Squad');
      const groupId = await createGroup(handle.db, tenantId, 'Division');
      await addTeamToGroup(handle.db, tenantId, teamId, groupId);
      await addTeamMember(handle.db, tenantId, teamId, userId);

      await withSystemPrivileges(handle.db, (tx) =>
        tx.delete(tenants).where(eq(tenants.id, tenantId)),
      );

      expect(await handle.db.select().from(teams).where(eq(teams.tenantId, tenantId))).toEqual([]);
      expect(await handle.db.select().from(groups).where(eq(groups.tenantId, tenantId))).toEqual(
        [],
      );
      expect(
        await handle.db.select().from(teamGroups).where(eq(teamGroups.tenantId, tenantId)),
      ).toEqual([]);
      expect(
        await handle.db
          .select()
          .from(teamMemberships)
          .where(eq(teamMemberships.tenantId, tenantId)),
      ).toEqual([]);
      expect(
        await handle.db.select().from(memberships).where(eq(memberships.tenantId, tenantId)),
      ).toEqual([]);
    });

    it('leaves the user and their personal tenant untouched', async () => {
      const { userId, personalTenantId } = await registerUser(handle.db, {
        email: 'ugo@example.com',
      });
      const tenantId = await createWorkTenant(handle.db, 'Doomed');
      await addMember(handle.db, tenantId, userId);

      await withSystemPrivileges(handle.db, (tx) =>
        tx.delete(tenants).where(eq(tenants.id, tenantId)),
      );

      expect(await handle.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
      expect(
        await handle.db.select().from(tenants).where(eq(tenants.id, personalTenantId)),
      ).toHaveLength(1);
    });
  });

  describe('deleting a team or group', () => {
    it('unlinks a deleted team without destroying the group', async () => {
      const tenantId = await createWorkTenant(handle.db, 'T');
      const teamId = await createTeam(handle.db, tenantId, 'Squad');
      const groupId = await createGroup(handle.db, tenantId, 'Division');
      await addTeamToGroup(handle.db, tenantId, teamId, groupId);

      await withSystemPrivileges(handle.db, (tx) => tx.delete(teams).where(eq(teams.id, teamId)));

      expect(
        await handle.db.select().from(teamGroups).where(eq(teamGroups.teamId, teamId)),
      ).toEqual([]);
      expect(await handle.db.select().from(groups).where(eq(groups.id, groupId))).toHaveLength(1);
    });

    it('unlinks a deleted group without destroying the team', async () => {
      const tenantId = await createWorkTenant(handle.db, 'T');
      const teamId = await createTeam(handle.db, tenantId, 'Squad');
      const groupId = await createGroup(handle.db, tenantId, 'Division');
      await addTeamToGroup(handle.db, tenantId, teamId, groupId);

      await withSystemPrivileges(handle.db, (tx) =>
        tx.delete(groups).where(eq(groups.id, groupId)),
      );

      expect(
        await handle.db.select().from(teamGroups).where(eq(teamGroups.groupId, groupId)),
      ).toEqual([]);
      expect(await handle.db.select().from(teams).where(eq(teams.id, teamId))).toHaveLength(1);
    });

    it('accepts a team that belongs to no group at all', async () => {
      // "Zero-or-more groups" (spec §4.2) — the zero case needs no link row and
      // must not require one.
      const tenantId = await createWorkTenant(handle.db, 'T');
      const teamId = await createTeam(handle.db, tenantId, 'Unaffiliated');

      const links = await handle.db.select().from(teamGroups).where(eq(teamGroups.teamId, teamId));
      expect(links).toEqual([]);
      expect(await handle.db.select().from(teams).where(eq(teams.id, teamId))).toHaveLength(1);
    });
  });

  describe('primary email lifecycle', () => {
    it('refuses to delete the primary address while others remain', async () => {
      const { userId } = await registerUser(handle.db, { email: 'vera@primary.example' });
      await withSystemPrivileges(handle.db, (tx) =>
        tx.insert(emailIdentities).values({ userId, email: 'vera@secondary.example' }),
      );

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.delete(emailIdentities).where(eq(emailIdentities.email, 'vera@primary.example')),
        ),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('allows removing every address at once', async () => {
      // Zero addresses is a legitimate state — it is where a freshly created
      // principal starts, before one is attached.
      const { userId } = await registerUser(handle.db, { email: 'walt@example.com' });

      await withSystemPrivileges(handle.db, (tx) =>
        tx.delete(emailIdentities).where(eq(emailIdentities.userId, userId)),
      );

      expect(
        await handle.db.select().from(emailIdentities).where(eq(emailIdentities.userId, userId)),
      ).toEqual([]);
      expect(await handle.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
    });

    it('allows swapping the primary by deleting it alongside a promotion', async () => {
      const { userId } = await registerUser(handle.db, { email: 'xena@old.example' });

      await withSystemPrivileges(handle.db, async (tx) => {
        await tx.insert(emailIdentities).values({ userId, email: 'xena@new.example' });
        await tx.delete(emailIdentities).where(eq(emailIdentities.email, 'xena@old.example'));
        await tx
          .update(emailIdentities)
          .set({ isPrimary: true })
          .where(eq(emailIdentities.email, 'xena@new.example'));
      });

      const rows = await handle.db
        .select({ email: emailIdentities.email, isPrimary: emailIdentities.isPrimary })
        .from(emailIdentities)
        .where(eq(emailIdentities.userId, userId));
      expect(rows).toEqual([{ email: 'xena@new.example', isPrimary: true }]);
    });
  });
});
