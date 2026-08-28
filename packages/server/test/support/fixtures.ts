import { withSystemPrivileges } from '../../src/db/context.js';
import { registerUser } from '../../src/identity/register-user.js';
import {
  groups,
  memberships,
  teamGroups,
  teamMemberships,
  teams,
  tenants,
} from '../../src/db/schema/index.js';
import type { Database } from '../../src/db/client.js';

/**
 * Fixtures are built on the system path on purpose: arranging a scenario is not
 * the behaviour under test, and building it through RLS would make every test
 * depend on the policies it is trying to check.
 */

export async function createWorkTenant(db: Database, name: string): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ name }).returning({ id: tenants.id });
    if (!tenant) throw new Error('Failed to create tenant');
    return tenant.id;
  });
}

export async function addMember(
  db: Database,
  tenantId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' = 'member',
): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx
      .insert(memberships)
      .values({ tenantId, userId, role })
      .returning({ id: memberships.id });
    if (!row) throw new Error('Failed to create membership');
    return row.id;
  });
}

export async function createTeam(db: Database, tenantId: string, name: string): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx.insert(teams).values({ tenantId, name }).returning({ id: teams.id });
    if (!row) throw new Error('Failed to create team');
    return row.id;
  });
}

export async function createGroup(db: Database, tenantId: string, name: string): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx.insert(groups).values({ tenantId, name }).returning({ id: groups.id });
    if (!row) throw new Error('Failed to create group');
    return row.id;
  });
}

export async function addTeamToGroup(
  db: Database,
  tenantId: string,
  teamId: string,
  groupId: string,
): Promise<void> {
  await withSystemPrivileges(db, async (tx) => {
    await tx.insert(teamGroups).values({ tenantId, teamId, groupId });
  });
}

export async function addTeamMember(
  db: Database,
  tenantId: string,
  teamId: string,
  userId: string,
): Promise<void> {
  await withSystemPrivileges(db, async (tx) => {
    await tx.insert(teamMemberships).values({ tenantId, teamId, userId });
  });
}

export { registerUser };
