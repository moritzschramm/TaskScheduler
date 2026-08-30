ALTER TABLE "task_occurrences" DROP CONSTRAINT "task_occurrences_task_period_key";--> statement-breakpoint
CREATE INDEX "task_occurrences_task_period_idx" ON "task_occurrences" USING btree ("task_id","period_start");--> statement-breakpoint

UPDATE app_meta SET value = 'm14' WHERE key = 'schema_version';
