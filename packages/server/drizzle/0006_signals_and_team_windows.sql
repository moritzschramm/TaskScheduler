CREATE TABLE "team_windows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_windows_weekday_range" CHECK ("team_windows"."weekday" between 1 and 7),
	CONSTRAINT "team_windows_minute_range" CHECK ("team_windows"."start_min" >= 0 and "team_windows"."end_min" <= 1440 and "team_windows"."start_min" < "team_windows"."end_min")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "team_windows" ADD CONSTRAINT "team_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_windows" ADD CONSTRAINT "team_windows_team_same_tenant_fk" FOREIGN KEY ("team_id","tenant_id") REFERENCES "public"."teams"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_live_signal_key" ON "notifications" USING btree ("user_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null and "notifications"."read_at" is null;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tenant isolation for the new table (spec §5.2).
--
-- `drizzle-kit generate` produces DDL from the Drizzle schema and knows nothing
-- about policies, so a table added this way would arrive unprotected. The
-- schema guard test is what notices; this is what satisfies it.
-- ---------------------------------------------------------------------------

ALTER TABLE team_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY team_windows_tenant_isolation ON team_windows FOR ALL TO ambitime_app
  USING (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id))
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_current_user_is_member(tenant_id));
--> statement-breakpoint

-- Without it `version` never advances and optimistic locking (§5.4) silently
-- accepts every concurrent write.
CREATE TRIGGER team_windows_touch_row
  BEFORE UPDATE ON team_windows
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION touch_row();
--> statement-breakpoint

UPDATE app_meta SET value = 'm13' WHERE key = 'schema_version';
