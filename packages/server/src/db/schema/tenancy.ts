import { sql } from 'drizzle-orm';
import {
  foreignKey,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, primaryKeyColumn, updatedAtColumn, versionColumn } from './columns.js';
import { users } from './identity.js';

/** Coarse RBAC roles (spec §10.2); maps to the Better Auth organization plugin. */
export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'member']);

/**
 * The isolation boundary (spec §4.2). Every tenant-scoped row carries
 * `tenant_id` and is filtered by RLS against `app.tenant_id`.
 *
 * A tenant is *personal* when `personal_owner_id` is set. Representing it that
 * way rather than with a `kind` enum means "exactly one personal tenant per
 * user" is enforced structurally by the unique index below — there is no second
 * column that could disagree with the first.
 *
 * `name` is a plain identifier, not a display string: the personal tenant is
 * created by a trigger, and the database must not invent user-visible,
 * localisable text (spec §13). The UI labels personal tenants itself.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: primaryKeyColumn(),
    name: text('name').notNull(),
    personalOwnerId: uuid('personal_owner_id').references(() => users.id, { onDelete: 'cascade' }),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('tenants_one_personal_per_user')
      .on(table.personalOwnerId)
      .where(sql`${table.personalOwnerId} is not null`),
  ],
);

/** User ↔ Tenant with a role (spec §4.2). */
export const memberships = pgTable(
  'memberships',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('member'),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Also the target of `team_memberships`' composite FK: you cannot be on a
    // team in a tenant you do not belong to.
    unique('memberships_tenant_user_key').on(table.tenantId, table.userId),
  ],
);

/** Tenant-scoped; contains zero or more teams (spec §4.2). */
export const groups = pgTable(
  'groups',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('groups_id_tenant_key').on(table.id, table.tenantId),
    unique('groups_tenant_name_key').on(table.tenantId, table.name),
  ],
);

/** Tenant-scoped; belongs to zero or more groups (spec §4.2). */
export const teams = pgTable(
  'teams',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('teams_id_tenant_key').on(table.id, table.tenantId),
    unique('teams_tenant_name_key').on(table.tenantId, table.name),
  ],
);

/**
 * Team ↔ Group, many-to-many (spec §4.2: a team belongs to zero-or-more groups;
 * a group contains multiple teams).
 *
 * A pure link table, so no `version`: nothing here is ever UPDATEd, and an
 * optimistic-locking column that no command reads would be misleading state.
 *
 * The two composite foreign keys are what make a cross-tenant link impossible:
 * both sides must resolve within the row's own `tenant_id`.
 */
export const teamGroups = pgTable(
  'team_groups',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull(),
    groupId: uuid('group_id').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.groupId] }),
    foreignKey({
      columns: [table.teamId, table.tenantId],
      foreignColumns: [teams.id, teams.tenantId],
      name: 'team_groups_team_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.groupId, table.tenantId],
      foreignColumns: [groups.id, groups.tenantId],
      name: 'team_groups_group_same_tenant_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * User ↔ Team (spec §4.2). A user may be in multiple teams, and through them in
 * multiple groups.
 *
 * The `(tenant_id, user_id)` foreign key into `memberships` enforces that team
 * membership implies tenant membership, and makes removing someone from a
 * tenant cascade them out of its teams.
 */
export const teamMemberships = pgTable(
  'team_memberships',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('team_memberships_team_user_key').on(table.teamId, table.userId),
    foreignKey({
      columns: [table.teamId, table.tenantId],
      foreignColumns: [teams.id, teams.tenantId],
      name: 'team_memberships_team_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'team_memberships_requires_tenant_membership_fk',
    }).onDelete('cascade'),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamGroup = typeof teamGroups.$inferSelect;
export type TeamMembership = typeof teamMemberships.$inferSelect;
export type NewTeamMembership = typeof teamMemberships.$inferInsert;
