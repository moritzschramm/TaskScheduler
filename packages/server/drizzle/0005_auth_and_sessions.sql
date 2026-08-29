-- ============================================================================
-- Better Auth: sessions, credentials, invitations and identity providers, plus
-- the mapping of its `user`, `organization` and `member` models onto the tables
-- M1 already had (spec §10.1, §4.2).
--
-- Same split as migrations 0002 and 0004: drizzle-kit generates the DDL, and
-- everything security- or invariant-critical is hand-written below it so it can
-- be read directly rather than inferred from a schema file.
-- ============================================================================


CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_issuer_account_key" UNIQUE("issuer","account_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"team_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"active_organization_id" uuid,
	"active_team_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" uuid,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_providers_provider_id_key" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
-- Backfill from the primary address before demanding one: the column is new,
-- but the fact it holds is not (spec §4.1).
UPDATE "users" u
   SET "email" = e."email"
  FROM "email_identities" e
 WHERE e."user_id" = u."id" AND e."is_primary";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "slug" text DEFAULT 't-' || replace(uuidv7()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_tenants_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_tenants_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_organization_id_tenants_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitations_organization_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sso_providers_organization_idx" ON "sso_providers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_key" UNIQUE("slug");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. The auth tables are unreachable from a tenant-scoped request (spec §5.2)
--
-- Migration 0002 grants `ambitime_app` full DML on every table, present and
-- future, and every tenant-scoped statement in the app runs as that role. These
-- five tables are the exception: they hold password hashes and live session
-- tokens, and there is no request in the application for which the right answer
-- is to read one. So the grant is taken back.
--
-- RLS is enabled behind that with **no policy at all**, which under Postgres
-- means deny. Two independent things would have to be wrong before a session
-- token became readable through a request, rather than one.
--
-- Better Auth reaches these tables on the system path, above the policies —
-- the same arrangement `withSystemPrivileges` describes for everything else
-- that genuinely cannot be tenant-scoped.
-- ---------------------------------------------------------------------------

REVOKE ALL ON sessions FROM ambitime_app;--> statement-breakpoint
REVOKE ALL ON accounts FROM ambitime_app;--> statement-breakpoint
REVOKE ALL ON verifications FROM ambitime_app;--> statement-breakpoint
REVOKE ALL ON invitations FROM ambitime_app;--> statement-breakpoint
REVOKE ALL ON sso_providers FROM ambitime_app;--> statement-breakpoint

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sso_providers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 2. The personal tenant is an organization too (spec §4.2)
--
-- Only change: it needs a slug, because Better Auth's organization model
-- requires a unique one. Derived from the user's id rather than from their name
-- or address — a slug appears in URLs, and §14's security baseline says no
-- personal data belongs there.
--
-- The rest of the function is untouched, including the reason it exists: the
-- personal tenant and its `owner` membership are created by the database, so
-- the invariant holds no matter which code path made the user. From this
-- migration on, that path is usually Better Auth's sign-up.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_personal_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  INSERT INTO public.tenants (name, slug, personal_owner_id)
  VALUES ('personal', 'personal-' || replace(NEW.id::text, '-', ''), NEW.id)
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.memberships (tenant_id, user_id, role)
  VALUES (v_tenant_id, NEW.id, 'owner');

  RETURN NEW;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION create_personal_tenant() FROM PUBLIC;--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 3. `users.email` and the primary `email_identities` row are one address
--    (spec §4.1, §10.1)
--
-- §4.1 wants many addresses per person; Better Auth requires exactly one on the
-- user, unique, to authenticate against. Both hold: the user's column is the
-- login address, and `email_identities` remains the record of every address
-- they have, the primary one being that same address.
--
-- Kept true in **both** directions, because either side can be written first:
-- Better Auth's sign-up and change-email flows write `users`, and the app's own
-- address management (later) writes `email_identities`. A single direction
-- would leave the other able to drift silently, which for a login credential is
-- the kind of drift nobody notices until they cannot sign in.
--
-- Each guard is `IS DISTINCT FROM`, which is also what stops the two triggers
-- calling each other forever: the second write is a no-op and fires nothing.
--
-- SECURITY DEFINER for the same reason as every other trigger here — under RLS
-- a mirror that could only see rows the caller may read would mirror nothing.
-- ---------------------------------------------------------------------------

CREATE FUNCTION mirror_primary_email_from_user() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  UPDATE public.email_identities
     SET email = NEW.email
   WHERE user_id = NEW.id
     AND is_primary
     AND email IS DISTINCT FROM NEW.email;

  -- A user who has no primary address yet — which is every user, one statement
  -- after they were created — gets one.
  INSERT INTO public.email_identities (user_id, email, is_primary)
  SELECT NEW.id, NEW.email, true
  WHERE NOT EXISTS (
    SELECT 1 FROM public.email_identities WHERE user_id = NEW.id AND is_primary
  );

  RETURN NEW;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION mirror_primary_email_from_user() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER users_mirror_primary_email
  AFTER INSERT OR UPDATE OF email ON users
  FOR EACH ROW
  EXECUTE FUNCTION mirror_primary_email_from_user();--> statement-breakpoint

CREATE FUNCTION mirror_user_email_from_primary() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.is_primary THEN
    UPDATE public.users
       SET email = NEW.email
     WHERE id = NEW.user_id
       AND email IS DISTINCT FROM NEW.email;
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION mirror_user_email_from_primary() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER email_identities_mirror_user
  AFTER INSERT OR UPDATE OF email, is_primary ON email_identities
  FOR EACH ROW
  EXECUTE FUNCTION mirror_user_email_from_primary();
