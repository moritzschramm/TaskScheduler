ALTER TABLE "users" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_day_of_week" smallint;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_first_day_of_week_range" CHECK ("users"."first_day_of_week" is null or "users"."first_day_of_week" between 1 and 7);--> statement-breakpoint

UPDATE app_meta SET value = 'm16' WHERE key = 'schema_version';
