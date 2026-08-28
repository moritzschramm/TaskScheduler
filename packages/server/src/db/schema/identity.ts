import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAtColumn, primaryKeyColumn, updatedAtColumn, versionColumn } from './columns.js';

/**
 * The global authentication principal — one row per human (spec §4.1).
 *
 * Deliberately **not** tenant-scoped: a user exists above the tenant boundary
 * and may hold memberships in many tenants. Row visibility is therefore keyed
 * on the user boundary rather than `tenant_id` (see the RLS policies in the
 * migration, and spec §5.3).
 *
 * Inserting a row here also creates the user's personal tenant and an `owner`
 * membership in it, via the `create_personal_tenant()` trigger — so the
 * invariant holds regardless of which code path creates the user (spec §4.2).
 * That matters from M8 onwards, when Better Auth writes this table directly.
 */
export const users = pgTable('users', {
  id: primaryKeyColumn(),
  /** Free-form display name; neither an identifier nor unique. */
  displayName: text('display_name'),
  version: versionColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

/**
 * Email → User, many-to-one, exactly one marked primary (spec §4.1). Kept
 * separate from `users` so one human can hold several addresses — work and
 * private — that all resolve to the same principal.
 */
export const emailIdentities = pgTable(
  'email_identities',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Addresses are compared case-insensitively; the index is what makes that
    // true rather than a convention application code has to remember.
    uniqueIndex('email_identities_email_lower_key').on(sql`lower(${table.email})`),
    // "Exactly one primary" is half-enforced here (at most one). The other half
    // — at least one — is a deferred check in the migration, because the first
    // address must be insertable before it can be marked primary.
    uniqueIndex('email_identities_one_primary_per_user')
      .on(table.userId)
      .where(sql`${table.isPrimary}`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type EmailIdentity = typeof emailIdentities.$inferSelect;
export type NewEmailIdentity = typeof emailIdentities.$inferInsert;
