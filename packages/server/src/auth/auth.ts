import { sso } from '@better-auth/sso';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import {
  accounts,
  invitations,
  memberships,
  sessions,
  ssoProviders,
  tenants,
  users,
  verifications,
} from '../db/schema/index.js';
import type { Database } from '../db/client.js';

/**
 * Better Auth, self-hosted against the app's own Postgres (spec §10.1).
 *
 * **The models map onto the tables that were already there.** §4.2 says a
 * Tenant "maps to the Better Auth organization" and §10.1 says the organization
 * plugin *is* Tenant / Membership / roles, so `user`, `organization` and
 * `member` are `users`, `tenants` and `memberships` — not a second set of
 * tables beside them. Only what the domain has no opinion about — credentials,
 * sessions, invitations, identity providers — is Better Auth's alone.
 *
 * The consequence worth stating plainly: **the personal-tenant invariant now
 * holds for sign-up without sign-up knowing about it.** Better Auth inserts a
 * row into `users`, and the same triggers that M1 put there create the personal
 * tenant, the `owner` membership and the primary email identity. That is what
 * the trigger was for, and this is the code path it was written against.
 */

export interface AuthOptions {
  db: Database;
  /** Signing key for session cookies and tokens. */
  secret: string;
  /** Public origin the app is reached at, for cookie and callback URLs. */
  baseURL: string;
  /** Origins allowed to carry credentials; the CORS list, reused. */
  trustedOrigins?: string[];
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth({ db, secret, baseURL, trustedOrigins = [] }: AuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins,

    database: drizzleAdapter(db, {
      provider: 'pg',
      // Keyed by *model* name, which the options below have already remapped:
      // `user` resolves to `users`, `organization` to `tenants`, and so on.
      schema: {
        users,
        sessions,
        accounts,
        verifications,
        tenants,
        memberships,
        invitations,
        ssoProviders,
      },
    }),

    advanced: {
      database: {
        /**
         * Let Postgres mint the ids. Every table defaults to `uuidv7()`, and
         * §5.1 wants that specifically: time-ordered keys give the scheduler
         * deterministic tie-breaks (§6.3) and the index better locality. Better
         * Auth would otherwise generate its own, which are valid UUIDs and
         * would satisfy the column while quietly costing both.
         */
        generateId: false,
      },
    },

    emailAndPassword: {
      enabled: true,
      /**
       * Verification is a delivery problem, and delivery is M15's (pg-boss,
       * §11). Requiring it now would mean nobody could sign in.
       */
      requireEmailVerification: false,
    },

    user: {
      modelName: 'users',
      // Better Auth's `name` is this app's `display_name` (§4.1): free-form,
      // not an identifier. Every other field it needs is named the same here.
      fields: { name: 'displayName' },
    },

    session: { modelName: 'sessions' },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },

    databaseHooks: {
      session: {
        create: {
          /**
           * A new session starts in the user's personal tenant (§4.2).
           *
           * Without this the session begins with no active organization, and
           * every request would have to decide what to do about that. Choosing
           * once, here, means a signed-in request always has somewhere to be —
           * and the one tenant a user is guaranteed to belong to is the one the
           * database made for them.
           */
          before: async (session) => {
            const [personal] = await db
              .select({ id: tenants.id })
              .from(tenants)
              .where(eq(tenants.personalOwnerId, session.userId))
              .limit(1);

            return personal
              ? { data: { ...session, activeOrganizationId: personal.id } }
              : { data: session };
          },
        },
      },
    },

    plugins: [
      organization({
        schema: {
          organization: { modelName: 'tenants' },
          member: {
            modelName: 'memberships',
            // The only name the two models genuinely disagree on.
            fields: { organizationId: 'tenantId' },
          },
          invitation: { modelName: 'invitations' },
        },
        /**
         * Roles are left at the plugin's defaults — `owner`, `admin`, `member`
         * — because those are exactly §10.2's coarse RBAC and exactly the
         * values the `membership_role` enum has held since M1. Keeping the
         * column an enum rather than text is deliberate: a role this plugin
         * invented would be refused by the database rather than stored and
         * silently unenforceable.
         */
      }),

      /**
       * OIDC and SAML 2.0, **configured but not onboarded** (spec §10.1).
       *
       * The table, the routes and the company-domain → organization link all
       * exist; no provider is registered, and registering one is an operational
       * act rather than a code change. That is the whole of the enterprise
       * scaffold this milestone is asked for.
       */
      sso({
        schema: { ssoProvider: { modelName: 'ssoProviders' } },
        /**
         * A provider is linked to the organization that registered it, so a
         * person arriving from a company domain lands in that company's tenant
         * rather than in a personal one.
         */
        organizationProvisioning: { disabled: false },
      }),
    ],
  });
}

/** Where the auth routes live. Under `/api` like everything else the server serves. */
export const AUTH_BASE_PATH = '/api/auth';
