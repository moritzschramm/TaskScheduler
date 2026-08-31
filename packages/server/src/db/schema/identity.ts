import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAtColumn,
  createdAtDateColumn,
  primaryKeyColumn,
  updatedAtColumn,
  updatedAtDateColumn,
  versionColumn,
} from './columns.js';

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
 * Better Auth writes this table directly (§10.1), which is exactly the code
 * path that comment was written for.
 *
 * **The Better Auth `user` model maps here** (§10.1). `email`, `email_verified`
 * and `image` exist because Better Auth requires them; `display_name` carries
 * its `name`. The address is duplicated with `email_identities` on purpose —
 * see the note there.
 */
export const users = pgTable(
  'users',
  {
    id: primaryKeyColumn(),
    /** Free-form display name; neither an identifier nor unique. */
    displayName: text('display_name'),
    /**
     * The address the user signs in with, and the one Better Auth authenticates
     * against. Unique case-insensitively, like `email_identities`.
     */
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** Avatar URL. Better Auth's `image`; the app has no opinion about it yet. */
    image: text('image'),
    /**
     * Display settings (spec §13).
     *
     * All three are nullable, and unset means "follow the calendar" rather
     * than "use a default": a user who has never opened settings should see
     * exactly what they saw before the settings existed, and a stored default
     * would be a decision made on their behalf that they then have to notice
     * and undo.
     *
     * `firstDayOfWeek` is **display only**. It looks like §15's tuning value of
     * the same name, and deliberately does not feed the solve: the derived
     * schedule is a function of source state (§3.4), and letting a viewer's
     * preference reach it would make two members of one tenant disagree about
     * what the cache says.
     */
    locale: text('locale'),
    timeZone: text('time_zone'),
    /** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
    firstDayOfWeek: smallint('first_day_of_week'),

    /**
     * The heartbeat behind online/offline (spec §11).
     *
     * On the user rather than the session, because presence is a fact about a
     * person: someone signed in on a laptop and a phone is online once, and a
     * notification should reach them once.
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),

    version: versionColumn(),
    // Date-mode: Better Auth writes this table (§10.1). See `columns.ts`.
    createdAt: createdAtDateColumn(),
    updatedAt: updatedAtDateColumn(),
  },
  (table) => [
    uniqueIndex('users_email_lower_key').on(sql`lower(${table.email})`),
    check(
      'users_first_day_of_week_range',
      sql`${table.firstDayOfWeek} is null or ${table.firstDayOfWeek} between 1 and 7`,
    ),
  ],
);

/**
 * Email → User, many-to-one, exactly one marked primary (spec §4.1). Kept
 * separate from `users` so one human can hold several addresses — work and
 * private — that all resolve to the same principal.
 *
 * **On the duplication with `users.email`.** §4.1 wants many addresses per
 * person; Better Auth requires exactly one, unique, on the user (§10.1). Both
 * are true here: `users.email` is the *login* address, and this table is the
 * record of every address the person holds, the primary one being the same
 * address. The two are kept identical by the `mirror_primary_email` triggers in
 * migration 0005, in both directions, so neither can quietly become the odd one
 * out. A view over this table would have been the alternative, and would have
 * put Better Auth off its supported path for the sake of one column.
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
