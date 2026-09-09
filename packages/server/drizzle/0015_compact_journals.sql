-- ---------------------------------------------------------------------------
-- Finding the commands that still carry row images (spec §12).
--
-- Compaction drops a command's `changes` once it has fallen past the undo
-- window, which means the job's real question is "which rows still have any" —
-- and on a log where almost every row has already been stripped, that is a
-- question about a handful of rows being asked of all of them. Answering it by
-- reading `inverse` means detoasting the one column the whole exercise exists
-- to get rid of.
--
-- Partial, so the index holds only the rows that are still reversible: at most
-- the window's depth per actor, plus whatever has accumulated since the last
-- pass. It stays that size for ever, which is the point — the log grows and the
-- index does not. Every row enters it on insert and leaves it on compaction,
-- so the churn is one index entry per command, paid once.
--
-- `jsonb_exists(inverse, 'changes')` rather than `inverse ? 'changes'`: the
-- same operator, written as the function, because the predicate has to be
-- immutable for an index to be allowed to hold it and the function form says
-- so without a cast.
-- ---------------------------------------------------------------------------

CREATE INDEX "commands_reversible_idx" ON "commands" USING btree ("actor_id", "seq" DESC)
  WHERE jsonb_exists("inverse", 'changes');--> statement-breakpoint

UPDATE app_meta SET value = 'm20' WHERE key = 'schema_version';
