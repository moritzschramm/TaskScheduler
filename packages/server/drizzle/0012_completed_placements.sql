--
-- Where a task was when it was finished (spec §3.4, §7.3).
--
-- A completed occurrence stops being demand, so re-derivation stops placing it
-- and the cache stops containing it — which is exactly right for scheduling and
-- exactly wrong for looking at your week. The block simply vanished, taking
-- with it the only evidence that the afternoon had been spent.
--
-- The interval is copied onto the occurrence rather than left in `placements`,
-- because that table is a cache: §3.4 says it is replaced wholesale by every
-- solve, so a row kept there would be a fact that only survived until the next
-- re-derive. Source state is where a fact belongs, and "this was done, then,
-- there" is source state.
--
ALTER TABLE "task_occurrences" ADD COLUMN "completed_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_occurrences" ADD COLUMN "completed_end" timestamp with time zone;--> statement-breakpoint

-- Both or neither, and ordered. Half of an interval says nothing, and one that
-- ends before it starts would draw a block of negative height.
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_completed_interval" CHECK (
  ("task_occurrences"."completed_start" is null) = ("task_occurrences"."completed_end" is null)
  and ("task_occurrences"."completed_start" is null
       or "task_occurrences"."completed_start" < "task_occurrences"."completed_end")
);--> statement-breakpoint

-- Only a completed occurrence may carry one. A pending occurrence's placement
-- is the cache's business and changes with every solve.
ALTER TABLE "task_occurrences" ADD CONSTRAINT "task_occurrences_completed_interval_needs_completion" CHECK (
  "task_occurrences"."completed_start" is null or "task_occurrences"."status" = 'completed'
);--> statement-breakpoint

CREATE INDEX "task_occurrences_completed_start_idx" ON "task_occurrences" ("completed_start");--> statement-breakpoint

UPDATE app_meta SET value = 'm17' WHERE key = 'schema_version';
