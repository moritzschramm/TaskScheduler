-- ---------------------------------------------------------------------------
-- The overlap constraint stops two *concrete* blocks colliding (spec §5.3).
-- Recurrence gives the table two kinds of row that are not concrete blocks,
-- and the constraint has to stop applying to them.
--
-- A **template** (§8.1) is a rule. Its `during` is its first instance, kept so
-- the expansion knows the time of day and the duration — but the row stands for
-- a series, not for that one hour.
--
-- A **modified occurrence** replaces one instance of its template. Replacing
-- the *first* instance means occupying exactly the span the template's own
-- `during` describes, so the two necessarily overlap. Under the old constraint
-- "move just this one" was impossible for the first occurrence of every series.
--
-- Overlap *between expanded instances* is not policed here and cannot be: they
-- are derived and never become rows. That is the engine's business, exactly as
-- overlapping availability windows are (§6.2).
-- ---------------------------------------------------------------------------

ALTER TABLE appointments DROP CONSTRAINT appointments_no_overlap_per_calendar;
--> statement-breakpoint

ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap_per_calendar
  EXCLUDE USING gist (calendar_id WITH =, during WITH &&)
  WHERE (
    status <> 'cancelled'
    AND recurrence_rule IS NULL
    AND recurrence_parent_id IS NULL
  );
--> statement-breakpoint

UPDATE app_meta SET value = 'm14b' WHERE key = 'schema_version';
