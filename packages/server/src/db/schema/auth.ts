import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAtDateColumn, primaryKeyColumn, updatedAtDateColumn } from './columns.js';
import { tenants } from './tenancy.js';
import { users } from './identity.js';

/**
 * The tables Better Auth owns outright (spec §10.1).
 *
 * `user`, `organization` and `member` are *not* here: those models map onto
 * `users`, `tenants` and `memberships`, because §4.2 says a Tenant "maps to the
 * Better Auth organization" and meant it. What is left are the tables the app's
 * domain has no opinion about — credentials, sessions, pending invitations, and
 * the identity providers of the enterprise path.
 *
 * **None of them is reachable from a tenant-scoped request.** Migration 0005
 * revokes every privilege on them from `ambitime_app`, so a password hash or a
 * session token cannot be read through a request that has merely been pointed
 * at the right tenant. Better Auth reaches them on the system path, above the
 * policies, which is the same arrangement `withSystemPrivileges` describes for
 * everything else that cannot be tenant-scoped.
 *
 * Timestamps are `mode: 'date'`, which is the one place this schema departs
 * from the ISO strings everything else uses (§5.1). Better Auth's adapter hands
 * the driver `Date` objects and converts what comes back into `Date` either
 * way; the stored type is the same `timestamp with time zone` regardless. See
 * `createdAtDateColumn` in `columns.ts`.
 */

/**
 * A signed-in session (spec §10.1).
 *
 * `active_organization_id` is the whole reason the tenant context can be
 * derived rather than asserted: it is the tenant this session is currently
 * acting in, kept on the session row by Better Auth's organization plugin, so
 * a request carries its scope with it and cannot ask for another.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The opaque bearer value in the session cookie. */
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** The active tenant (§9). NULL until the first context is chosen. */
    activeOrganizationId: uuid('active_organization_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    /** Reserved by the organization plugin; teams are a deferred feature (§4.2). */
    activeTeamId: uuid('active_team_id'),
    createdAt: createdAtDateColumn(),
    updatedAt: updatedAtDateColumn(),
  },
  (table) => [
    unique('sessions_token_key').on(table.token),
    index('sessions_user_idx').on(table.userId),
  ],
);

/**
 * A credential or a linked provider account (spec §10.1).
 *
 * Email/password lives here too, as a row with `provider_id = 'credential'` and
 * the hash in `password` — which is why this table is the most privileged thing
 * in the database and the least reachable.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The provider's own id for this account. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    /** Issuer URL, for providers that have one. */
    issuer: text('issuer').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    scope: text('scope'),
    /** Hashed by Better Auth (scrypt); never a plaintext value. */
    password: text('password'),
    createdAt: createdAtDateColumn(),
    updatedAt: updatedAtDateColumn(),
  },
  (table) => [
    unique('accounts_issuer_account_key').on(table.issuer, table.accountId),
    index('accounts_user_idx').on(table.userId),
  ],
);

/** Short-lived tokens: email verification, password reset (spec §10.1). */
export const verifications = pgTable(
  'verifications',
  {
    id: primaryKeyColumn(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAtDateColumn(),
    updatedAt: updatedAtDateColumn(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

/**
 * A pending invitation into a tenant (spec §4.2, §10.1).
 *
 * `role` and `status` are text rather than enums: the organization plugin can
 * write a comma-separated role list and its own status vocabulary, and a column
 * that refused them would turn a plugin upgrade into a failed insert.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: primaryKeyColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    teamId: uuid('team_id'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAtDateColumn(),
  },
  (table) => [index('invitations_organization_idx').on(table.organizationId)],
);

/**
 * An enterprise identity provider, OIDC or SAML 2.0 (spec §10.1).
 *
 * The table exists and the plugin is configured; **no provider is onboarded**,
 * which is exactly what the milestone asks for. `domain` and
 * `organization_id` together are the company-domain → tenant link that the
 * enterprise path turns on: a person signing in from `acme.example` lands in
 * Acme's tenant rather than a personal one.
 */
export const ssoProviders = pgTable(
  'sso_providers',
  {
    id: primaryKeyColumn(),
    /** Stable handle used in the sign-in URL. */
    providerId: text('provider_id').notNull(),
    issuer: text('issuer').notNull(),
    domain: text('domain').notNull(),
    /** JSON, as Better Auth stores it — one of these two is set. */
    oidcConfig: text('oidc_config'),
    samlConfig: text('saml_config'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => tenants.id, { onDelete: 'cascade' }),
    createdAt: createdAtDateColumn(),
    updatedAt: updatedAtDateColumn(),
  },
  (table) => [
    unique('sso_providers_provider_id_key').on(table.providerId),
    index('sso_providers_organization_idx').on(table.organizationId),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type SsoProvider = typeof ssoProviders.$inferSelect;
