CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the row `/health` reads. Idempotent so re-running against an existing
-- database is harmless.
INSERT INTO "app_meta" ("key", "value")
VALUES ('schema_version', 'm0')
ON CONFLICT ("key") DO NOTHING;
