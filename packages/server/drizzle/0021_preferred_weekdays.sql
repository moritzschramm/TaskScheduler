-- ---------------------------------------------------------------------------
-- The other half of "always Tuesdays in the afternoon".
--
-- A task's preferred time has been a time *of day* since §4.4 was written —
-- `preferred_start_min` / `preferred_end_min`, minutes since local midnight —
-- with nothing anywhere saying *which days*. So "in the afternoon" was
-- expressible and "on Tuesdays" was not, and the only per-weekday thing in the
-- schema is `availability_windows`, which belongs to the activity type rather
-- than to the task.
--
-- One column rather than a table, because this is a *set of weekdays*, not a
-- set of windows: "Tuesday afternoons" is one preference, and the shape that
-- would also express "Tuesday afternoon or Thursday morning" is a table with
-- the same columns `availability_windows` already has. That is a bigger thing
-- and can be built later without this being in the way — a row per weekday
-- generalises a set of weekdays, never the reverse.
--
-- Inheritable like the rest of §4.4's preferences, which is what makes it
-- useful for a whole project at once: set "Tuesdays, 13:00–17:00" on the
-- container and every task under it is scored the same way.
--
-- **Soft, and the constraint is the point.** This never decides where a task
-- *may* go — §6.2 rule 1 leaves that to the availability windows alone. It
-- decides what a slot scores (§6.5's `Pr`), so a full Tuesday still means
-- Wednesday rather than nothing at all.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN preferred_weekdays smallint[];
--> statement-breakpoint

-- Non-empty when present — an empty set would mean "prefers no day", which is
-- what NULL already says — and every element an ISO weekday, matching the
-- `weekday` columns and Postgres's `extract(isodow)`. Duplicates are not
-- forbidden here because they are not wrong, only redundant: `{2,2}` and `{2}`
-- name the same Tuesday. The command schema sorts and de-duplicates on the way
-- in, so nothing written through §3.2's one write path carries either.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_preferred_weekdays_valid CHECK (
    preferred_weekdays IS NULL
    OR (
      cardinality(preferred_weekdays) > 0
      AND preferred_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
    )
  );
--> statement-breakpoint

UPDATE app_meta SET value = 'm26' WHERE key = 'schema_version';
