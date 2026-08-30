-- ---------------------------------------------------------------------------
-- A notification may be *addressed* to someone else (spec §7.2, §11).
--
-- The original policy scoped reading and writing alike to the caller's own
-- rows, which is right for reading and wrong for writing: §7.2 requires that
-- moving an internal appointment tells its other participants, and that means
-- inserting a row addressed to somebody who is not you.
--
-- Split, so each half says what it means. You may read only your own. You may
-- address one to anyone who shares the tenant — which is exactly the set of
-- people whose schedule your actions can affect.
-- ---------------------------------------------------------------------------

DROP POLICY notifications_own ON notifications;
--> statement-breakpoint

CREATE POLICY notifications_read_own ON notifications FOR SELECT TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
--> statement-breakpoint

CREATE POLICY notifications_update_own ON notifications FOR UPDATE TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id())
  WITH CHECK (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
--> statement-breakpoint

CREATE POLICY notifications_delete_own ON notifications FOR DELETE TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
--> statement-breakpoint

CREATE POLICY notifications_notify_members ON notifications FOR INSERT TO ambitime_app
  WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND app_current_user_is_member(tenant_id)
    AND EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.tenant_id = notifications.tenant_id
         AND m.user_id = notifications.user_id
    )
  );
--> statement-breakpoint

UPDATE app_meta SET value = 'm15b' WHERE key = 'schema_version';
