-- ============================================================================
-- Security layer and cross-row invariants for identity and tenancy (spec §5.2,
-- §5.3, §5.4). Hand-written rather than generated: policies are the part of
-- this milestone most worth reading closely, and they belong in plain SQL.
--
-- Any table added later (M2's scheduling tables) must repeat two things here:
-- ENABLE ROW LEVEL SECURITY plus at least one policy, and a touch_row trigger
-- if it carries a `version` column. `rls.test.ts` fails the build otherwise.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The application role
--
-- RLS is bypassed by superusers and by roles with BYPASSRLS. The owner role in
-- a stock Postgres image *is* a superuser, so policies on these tables would
-- silently do nothing on an ordinary connection. Every request therefore runs
-- under `SET LOCAL ROLE ambitime_app`, which has neither attribute.
--
-- NOLOGIN is deliberate: the role is only ever reached by SET ROLE from an
-- already-authenticated connection, so there is no second password to manage,
-- rotate, or leak.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ambitime_app') THEN
    CREATE ROLE ambitime_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint

-- Superusers may SET ROLE to anything, but the owner will not always be one.
GRANT ambitime_app TO CURRENT_USER;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO ambitime_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ambitime_app;
--> statement-breakpoint

-- So tables created by later migrations are reachable by the app without a
-- second grant that is easy to forget. Note this covers privileges only —
-- enabling RLS on those tables remains explicit, by design.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ambitime_app;
--> statement-breakpoint

-- app_meta is migration-owned configuration, not domain data. Revoking the
-- write privileges makes that a fact at the privilege layer rather than an
-- inference from the absence of a write policy — so a future `FOR ALL` policy
-- added by mistake cannot quietly open it up, and an attempted write fails
-- loudly instead of silently matching zero rows.
REVOKE INSERT, UPDATE, DELETE ON app_meta FROM ambitime_app;
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 2. Session context accessors
--
-- `current_setting(..., true)` yields NULL rather than raising when the setting
-- is absent. That is the load-bearing detail: with no context configured every
-- policy predicate evaluates to NULL, so an unconfigured session sees nothing
-- instead of everything. Deny by default.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- SECURITY DEFINER so it may read `memberships` without being subject to that
-- table's own policy — a policy on memberships that queries memberships would
-- otherwise recurse.
--
-- Scoped to the *current* user rather than taking a user argument, so it can
-- only ever answer a question the caller is already entitled to ask.
CREATE FUNCTION app_current_user_is_member(p_tenant_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.tenant_id = p_tenant_id
        AND m.user_id = app_current_user_id()
    )
  $$;
--> statement-breakpoint

-- "Is that user visible to me in the context I am currently acting in?"
-- Requires the caller to be a member of that context as well, so it cannot be
-- used to probe tenants the caller has nothing to do with.
CREATE FUNCTION app_user_shares_current_tenant(p_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT app_current_user_is_member(app_current_tenant_id())
       AND EXISTS (
         SELECT 1 FROM public.memberships m
         WHERE m.tenant_id = app_current_tenant_id()
           AND m.user_id = p_user_id
       )
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_current_user_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_tenant_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_user_is_member(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_shares_current_tenant(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_id() TO ambitime_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO ambitime_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_is_member(uuid) TO ambitime_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_shares_current_tenant(uuid) TO ambitime_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Row-level security policies
--
-- Two boundaries, not one (spec §5.3): tenant isolation for tenant-scoped
-- tables, and a user boundary for the global identity tables.
--
-- Policies are attached `TO ambitime_app` only. The owner role keeps
-- unrestricted access, which is what the deliberately-named system path in
-- `db/context.ts` uses for operations that cannot be tenant-scoped —
-- registration, tenant creation, migrations.
-- ---------------------------------------------------------------------------

-- app_meta is application-global configuration, not user data. It gets RLS with
-- a read-everything policy so the "every table is protected" check in
-- rls.test.ts needs no exception list — the absence of a write policy is the
-- statement that only migrations write here.
ALTER TABLE app_meta ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_meta_readable ON app_meta FOR SELECT TO ambitime_app USING (true);
--> statement-breakpoint


-- users: global principal (spec §4.1). Visible to yourself always, and to
-- people you currently share a tenant with — that is what makes participant
-- lists and team rosters resolvable without exposing the whole user table.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_self_or_co_member ON users FOR SELECT TO ambitime_app
  USING (id = app_current_user_id() OR app_user_shares_current_tenant(id));
--> statement-breakpoint
CREATE POLICY users_update_self ON users FOR UPDATE TO ambitime_app
  USING (id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());
--> statement-breakpoint
-- No INSERT or DELETE policy: registration and account deletion cannot be
-- tenant-scoped (there is no context to act in yet), so they run on the system
-- path instead.


-- email_identities: addresses are personal data and stay invisible to
-- co-members. Strictly narrower than `users` on purpose.
ALTER TABLE email_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY email_identities_own ON email_identities FOR ALL TO ambitime_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint


-- tenants: readable for every tenant you belong to, not just the active one —
-- the context switcher needs to list them. Mutable only within the active one.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenants_member_read ON tenants FOR SELECT TO ambitime_app
  USING (app_current_user_is_member(id));
--> statement-breakpoint
CREATE POLICY tenants_member_update ON tenants FOR UPDATE TO ambitime_app
  USING (id = app_current_tenant_id() AND app_current_user_is_member(id))
  WITH CHECK (id = app_current_tenant_id() AND app_current_user_is_member(id));
--> statement-breakpoint
-- No INSERT policy: you cannot be a member of a tenant that does not exist yet,
-- so tenant creation is inherently a system operation.


-- memberships: your own rows across every tenant (again, the switcher), plus
-- everyone's rows inside the active tenant.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_visible ON memberships FOR SELECT TO ambitime_app
  USING (
    user_id = app_current_user_id()
    OR (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  );
--> statement-breakpoint
CREATE POLICY memberships_write ON memberships FOR INSERT TO ambitime_app
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint
CREATE POLICY memberships_update ON memberships FOR UPDATE TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint
CREATE POLICY memberships_delete ON memberships FOR DELETE TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint
-- Role-gating these writes to owner/admin is application-layer RBAC and lands
-- with the auth provider in M8 (spec §10.2); the boundary enforced here is
-- membership of the active tenant.


-- groups / teams / team_groups / team_memberships: plain tenant scoping. The
-- membership re-check is redundant with the validation `withTenantContext`
-- performs before setting the GUC, and is kept as defence in depth — if that
-- helper ever set a context the user is not entitled to, these policies still
-- return nothing.

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY groups_tenant_isolation ON groups FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teams_tenant_isolation ON teams FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE team_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY team_groups_tenant_isolation ON team_groups FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE team_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY team_memberships_tenant_isolation ON team_memberships FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Optimistic locking (spec §5.4)
--
-- `version` is maintained here, never by application code. Commands supply an
-- *expected* version in their WHERE clause and check the row count; they do not
-- assign the next one. Keeping the increment in one trigger means a command
-- cannot forget it, and cannot fake it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION touch_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION touch_row() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER users_touch_row
  BEFORE UPDATE ON users
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER email_identities_touch_row
  BEFORE UPDATE ON email_identities
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER tenants_touch_row
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER memberships_touch_row
  BEFORE UPDATE ON memberships
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER groups_touch_row
  BEFORE UPDATE ON groups
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER teams_touch_row
  BEFORE UPDATE ON teams
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER team_memberships_touch_row
  BEFORE UPDATE ON team_memberships
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Personal-tenant bootstrap (spec §4.2)
--
-- "Each User has a personal tenant" is enforced by the database rather than by
-- whichever code path happens to create the user. That matters from M8, when
-- Better Auth writes `users` directly and knows nothing about our tenancy
-- model — the invariant holds anyway.
--
-- `name` is an identifier, not a display string: the database must not invent
-- user-visible text that later needs translating (spec §13). The UI recognises
-- a personal tenant by `personal_owner_id` and labels it in the user's locale.
--
-- SECURITY DEFINER because the inserts must succeed regardless of the role the
-- user was created under.
-- ---------------------------------------------------------------------------

CREATE FUNCTION create_personal_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  INSERT INTO public.tenants (name, personal_owner_id)
  VALUES ('personal', NEW.id)
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.memberships (tenant_id, user_id, role)
  VALUES (v_tenant_id, NEW.id, 'owner');

  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_personal_tenant() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER users_create_personal_tenant
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_personal_tenant();
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 6. Exactly one primary email per user (spec §4.1)
--
-- The unique index on `email_identities` covers "at most one". This covers "at
-- least one", and has to be DEFERRABLE: promoting a different address to
-- primary means two statements, and the intermediate state has zero or two
-- primaries. Checking at commit lets that reordering happen inside one
-- transaction without contortions.
--
-- A user with no addresses at all is allowed — that is the state right after
-- registration creates the principal but before an address is attached.
--
-- SECURITY DEFINER so the check sees every row: under RLS a constraint that
-- could only see rows the caller may read would be no constraint at all.
-- ---------------------------------------------------------------------------

CREATE FUNCTION assert_one_primary_email() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_user_id uuid := COALESCE(NEW.user_id, OLD.user_id);
  v_total integer;
  v_primary integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE is_primary)
    INTO v_total, v_primary
    FROM public.email_identities
   WHERE user_id = v_user_id;

  IF v_total > 0 AND v_primary <> 1 THEN
    RAISE EXCEPTION
      'user % must have exactly one primary email identity (found % primary of % total)',
      v_user_id, v_primary, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION assert_one_primary_email() FROM PUBLIC;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER email_identities_exactly_one_primary
  AFTER INSERT OR UPDATE OR DELETE ON email_identities
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_one_primary_email();
--> statement-breakpoint


-- Record what this migration established, for the /health readout.
UPDATE app_meta SET value = 'm1', updated_at = now() WHERE key = 'schema_version';
