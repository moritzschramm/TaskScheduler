-- ============================================================================
-- Database-level invariants for the scheduling domain, plus RLS for every table
-- migration 0003 added.
--
-- Same split as migration 0002: drizzle-kit generates the DDL, and everything
-- security- or invariant-critical is hand-written so it can be read directly.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Appointment non-overlap (spec §5.3, §6.2 rule 2)
--
-- btree_gist is what lets a plain-equality column (`calendar_id`) share a GiST
-- index with a range column, so the constraint can be scoped per calendar.
--
-- Cancelled appointments are excluded: they no longer occupy their time.
--
-- Recurring *templates* are included. A template's `during` is its first
-- instance, which is a genuinely occupied block, so constraining it is strictly
-- better than not. Instances beyond the first cannot be constrained here — an
-- unexpanded RRULE is opaque to the database — and are the validator's job once
-- expansion exists (M14, §6.2).
--
-- Note this is the *only* exclusion constraint in the schema. `placements`
-- deliberately has none; see the comment on that table.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap_per_calendar
  EXCLUDE USING gist (calendar_id WITH =, during WITH &&)
  WHERE (status <> 'cancelled');
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 2. Task hierarchy: depth ≤ 5 and no cycles (spec §4.4)
--
-- `depth` is maintained rather than trusted: application code never sets it, so
-- it cannot drift from the actual tree. The cap keeps the recursive CTE cheap
-- and is why an adjacency list suffices — no ltree, no closure table (§5.3).
-- ---------------------------------------------------------------------------

CREATE FUNCTION tasks_enforce_hierarchy() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_parent_depth smallint;
  v_ancestor uuid;
  v_steps integer := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.depth := 1;
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'task % cannot be its own parent', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT depth INTO v_parent_depth FROM public.tasks WHERE id = NEW.parent_id;
  IF v_parent_depth IS NULL THEN
    RAISE EXCEPTION 'parent task % does not exist', NEW.parent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Walk up from the proposed parent. Reaching this row means re-parenting
  -- would splice the tree into a loop, which the recursive reads below would
  -- then spin on forever.
  v_ancestor := NEW.parent_id;
  WHILE v_ancestor IS NOT NULL LOOP
    IF v_ancestor = NEW.id THEN
      RAISE EXCEPTION 'task % would become its own ancestor', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    v_steps := v_steps + 1;
    IF v_steps > 10 THEN
      -- Only reachable if the tree is already corrupt; fail rather than hang.
      RAISE EXCEPTION 'task ancestry walk exceeded the depth cap'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT parent_id INTO v_ancestor FROM public.tasks WHERE id = v_ancestor;
  END LOOP;

  NEW.depth := (v_parent_depth + 1)::smallint;

  IF NEW.depth > 5 THEN
    RAISE EXCEPTION
      'task hierarchy is capped at depth 5 (spec §4.4); this would be depth %', NEW.depth
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tasks_enforce_hierarchy() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER tasks_enforce_hierarchy
  BEFORE INSERT OR UPDATE OF parent_id, id ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_enforce_hierarchy();
--> statement-breakpoint

-- Re-parenting a node moves its whole subtree. Depths are rewritten from the
-- moved node downwards; the `tasks_depth_range` CHECK is what rejects a move
-- that would push any descendant past depth 5, so the cap holds for the subtree
-- and not merely for the node being moved.
CREATE FUNCTION tasks_resync_subtree_depth() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  WITH RECURSIVE subtree AS (
    SELECT t.id, NEW.depth AS depth
      FROM public.tasks t
     WHERE t.id = NEW.id
    UNION ALL
    SELECT t.id, (s.depth + 1)::smallint
      FROM public.tasks t
      JOIN subtree s ON t.parent_id = s.id
  )
  UPDATE public.tasks t
     SET depth = s.depth
    FROM subtree s
   WHERE t.id = s.id
     AND t.depth IS DISTINCT FROM s.depth;

  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tasks_resync_subtree_depth() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER tasks_resync_subtree_depth
  AFTER UPDATE OF parent_id ON tasks
  FOR EACH ROW
  WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id)
  EXECUTE FUNCTION tasks_resync_subtree_depth();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Inherited due dates (spec §4.4)
--
-- "A child's effective due date must be ≤ its inherited/effective parent due
-- date" — a subtask cannot outlive its container.
--
-- *Effective* is the load-bearing word: properties inherit nearest-ancestor-
-- wins, so the comparison is not against the parent's own column (which may be
-- NULL) but against the first non-NULL due date found walking upwards.
-- ---------------------------------------------------------------------------

CREATE FUNCTION task_effective_due_date(p_task_id uuid)
  RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH RECURSIVE ancestry AS (
    SELECT t.id, t.parent_id, t.due_date, 0 AS steps
      FROM public.tasks t
     WHERE t.id = p_task_id
    UNION ALL
    SELECT t.id, t.parent_id, t.due_date, a.steps + 1
      FROM public.tasks t
      JOIN ancestry a ON t.id = a.parent_id
     WHERE a.steps < 5
  )
  SELECT due_date
    FROM ancestry
   WHERE due_date IS NOT NULL
   ORDER BY steps
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION task_effective_due_date(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION task_effective_due_date(uuid) TO ambitime_app;
--> statement-breakpoint

-- Checks the subtree rooted at the changed row, not just the row itself:
-- tightening a *parent's* due date can invalidate a descendant that was legal a
-- moment ago, and that violation has to surface too.
--
-- SECURITY DEFINER so the walk sees the whole tree — under RLS a check that
-- could only see rows the caller may read would be no check at all.
CREATE FUNCTION assert_task_due_within_parent() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  offender record;
BEGIN
  FOR offender IN
    WITH RECURSIVE subtree AS (
      SELECT t.id, t.parent_id, t.due_date
        FROM public.tasks t
       WHERE t.id = NEW.id
      UNION ALL
      SELECT t.id, t.parent_id, t.due_date
        FROM public.tasks t
        JOIN subtree s ON t.parent_id = s.id
    )
    SELECT s.id,
           s.due_date,
           public.task_effective_due_date(s.parent_id) AS parent_due
      FROM subtree s
     WHERE s.due_date IS NOT NULL
       AND s.parent_id IS NOT NULL
  LOOP
    IF offender.parent_due IS NOT NULL AND offender.due_date > offender.parent_due THEN
      RAISE EXCEPTION
        'task % is due % but its container is due % (spec §4.4: a child cannot be due after its parent)',
        offender.id, offender.due_date, offender.parent_due
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION assert_task_due_within_parent() FROM PUBLIC;
--> statement-breakpoint

-- Deferred: moving a parent and its children to new dates takes several
-- statements, and the intermediate states are legitimately inconsistent. What
-- has to hold is the state at commit.
CREATE CONSTRAINT TRIGGER tasks_due_date_within_parent
  AFTER INSERT OR UPDATE OF due_date, parent_id ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_task_due_within_parent();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Row-level security for the scheduling tables
--
-- Every table below is tenant-scoped, so they all take the same policy shape as
-- M1's: the row's tenant must be the active context, and the caller must hold a
-- membership in it. Table privileges arrive automatically from the
-- ALTER DEFAULT PRIVILEGES set in migration 0002; RLS does not, which is why it
-- is spelled out here and why `schema-guard.test.ts` fails the build if a table
-- is ever added without it.
-- ---------------------------------------------------------------------------

ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY calendars_tenant_isolation ON calendars FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE calendar_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY calendar_windows_tenant_isolation ON calendar_windows FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY categories_tenant_isolation ON categories FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE week_type_overrides ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY week_type_overrides_tenant_isolation ON week_type_overrides FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE availability_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY availability_windows_tenant_isolation ON availability_windows FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sequences_tenant_isolation ON sequences FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tasks_tenant_isolation ON tasks FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE task_occurrences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY task_occurrences_tenant_isolation ON task_occurrences FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY appointments_tenant_isolation ON appointments FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE appointment_participants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY appointment_participants_tenant_isolation ON appointment_participants FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

ALTER TABLE placements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY placements_tenant_isolation ON placements FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint


-- notifications are addressed to a person, not merely to a tenant: co-members
-- share a context but must not read each other's alerts.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notifications_own ON notifications FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id())
  WITH CHECK (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
--> statement-breakpoint


-- commands is the append-only log (spec §12). Readable and insertable within
-- the active tenant; never updated or deleted. The missing UPDATE/DELETE
-- policies state the intent, and the revoked privileges below enforce it even
-- if a later migration adds a careless `FOR ALL` policy — the same belt-and-
-- braces treatment app_meta gets.
--
-- "Undone" is therefore not a flag on a row: undo is itself a command naming
-- its target (§7.5), so the log stays an honest record of intent in order.
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY commands_read ON commands FOR SELECT TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint
CREATE POLICY commands_append ON commands FOR INSERT TO ambitime_app
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND app_current_user_is_member(tenant_id)
    AND actor_id = app_current_user_id()
  );
--> statement-breakpoint
REVOKE UPDATE, DELETE ON commands FROM ambitime_app;
--> statement-breakpoint
-- The log's ordering sequence must stay writable for INSERT to work.
GRANT USAGE ON SEQUENCE commands_seq_seq TO ambitime_app;
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 5. Optimistic locking triggers (spec §5.4)
--
-- Same `touch_row()` from migration 0002. Deliberately absent from `placements`
-- (a cache, replaced wholesale) and `commands` (never updated).
-- ---------------------------------------------------------------------------

CREATE TRIGGER calendars_touch_row
  BEFORE UPDATE ON calendars
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER calendar_windows_touch_row
  BEFORE UPDATE ON calendar_windows
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER categories_touch_row
  BEFORE UPDATE ON categories
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER week_type_overrides_touch_row
  BEFORE UPDATE ON week_type_overrides
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER availability_windows_touch_row
  BEFORE UPDATE ON availability_windows
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER sequences_touch_row
  BEFORE UPDATE ON sequences
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER tasks_touch_row
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER task_occurrences_touch_row
  BEFORE UPDATE ON task_occurrences
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER appointments_touch_row
  BEFORE UPDATE ON appointments
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER appointment_participants_touch_row
  BEFORE UPDATE ON appointment_participants
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

CREATE TRIGGER notifications_touch_row
  BEFORE UPDATE ON notifications
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint


UPDATE app_meta SET value = 'm2', updated_at = now() WHERE key = 'schema_version';
