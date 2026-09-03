-- ---------------------------------------------------------------------------
-- Undo reads one actor's log, newest first (spec §7.5).
--
-- The log had `(tenant_id, seq)`, which serves the audit view. Undo asks a
-- different question — *this person's* last two hundred commands — and with no
-- index on the actor it was answered by walking the tenant's log backwards and
-- discarding everybody else's rows. Fine for one person in a tenant, and
-- steadily worse for each one added, which is exactly the wrong direction for a
-- feature whose whole point is that it belongs to you rather than to the team.
--
-- Descending on `seq` because that is the order it is read in; a backwards scan
-- of an ascending index would also work, and saying it costs nothing.
-- ---------------------------------------------------------------------------

CREATE INDEX "commands_actor_seq_idx" ON "commands" USING btree ("actor_id", "seq" DESC);--> statement-breakpoint

UPDATE app_meta SET value = 'm18' WHERE key = 'schema_version';
