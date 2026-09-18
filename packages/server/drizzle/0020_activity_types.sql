-- ---------------------------------------------------------------------------
-- `categories` is called an **activity type** everywhere a person can see it.
--
-- The interface has said "activity type" since the settings page was written —
-- the heading, the task editor's field, the empty states, the German — and the
-- schema underneath has said `categories` since migration 0003. One concept
-- with two names is survivable on its own; what makes it worth a migration is
-- that the word is about to be *needed* for something else. §4.3's plan for
-- sorting tasks *within* an activity type (a project at work, a room at home)
-- has no good name left if `category` is already spent on the thing above it,
-- and a schema with `categories.category_id` would be unreadable.
--
-- Renames, not a copy: every row keeps its id, so nothing that points at an
-- activity type has to be rewritten, and the change is invisible to the data.
-- Postgres re-resolves check expressions, indexes, policies and foreign keys
-- to the renamed object automatically; their *names* do not follow, which is
-- why each is renamed here by hand rather than left to read `categories_*` on
-- a table that no longer exists.
--
-- **What this migration cannot reach.** `commands.inverse` holds row images
-- keyed by table name and column name (§12), and that log is append-only —
-- UPDATE and DELETE are revoked from the application role, so the entries
-- written before today go on saying `categories` and `categoryId` forever.
-- They are read by `applyChanges`, which now maps the old names onto the new
-- ones; see `journal.ts`. Undo of a command issued before this migration keeps
-- working, and it keeps working because the reader was taught the old
-- vocabulary, not because the log was rewritten.
-- ---------------------------------------------------------------------------

ALTER TABLE categories RENAME TO activity_types;
--> statement-breakpoint

ALTER TABLE activity_types RENAME CONSTRAINT categories_pkey TO activity_types_pkey;
--> statement-breakpoint
ALTER TABLE activity_types
  RENAME CONSTRAINT categories_id_tenant_key TO activity_types_id_tenant_key;
--> statement-breakpoint
ALTER TABLE activity_types
  RENAME CONSTRAINT categories_tenant_name_key TO activity_types_tenant_name_key;
--> statement-breakpoint
ALTER TABLE activity_types
  RENAME CONSTRAINT categories_cooldown_non_negative TO activity_types_cooldown_non_negative;
--> statement-breakpoint
ALTER TABLE activity_types
  RENAME CONSTRAINT categories_color_is_a_palette_slot TO activity_types_color_is_a_palette_slot;
--> statement-breakpoint
ALTER TABLE activity_types
  RENAME CONSTRAINT categories_tenant_id_tenants_id_fk TO activity_types_tenant_id_tenants_id_fk;
--> statement-breakpoint

-- The row-level policy of migration 0004 and the `touch_row()` trigger of the
-- same one. Both still apply to the renamed table; only their own names are
-- stale.
ALTER POLICY categories_tenant_isolation ON activity_types
  RENAME TO activity_types_tenant_isolation;
--> statement-breakpoint
ALTER TRIGGER categories_touch_row ON activity_types RENAME TO activity_types_touch_row;
--> statement-breakpoint

-- The two tables that point at one.
ALTER TABLE availability_windows RENAME COLUMN category_id TO activity_type_id;
--> statement-breakpoint
ALTER TABLE availability_windows
  RENAME CONSTRAINT availability_windows_category_same_tenant_fk
  TO availability_windows_activity_type_same_tenant_fk;
--> statement-breakpoint

ALTER TABLE tasks RENAME COLUMN category_id TO activity_type_id;
--> statement-breakpoint
ALTER TABLE tasks
  RENAME CONSTRAINT tasks_category_same_tenant_fk TO tasks_activity_type_same_tenant_fk;
--> statement-breakpoint

UPDATE app_meta SET value = 'm25' WHERE key = 'schema_version';
