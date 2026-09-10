-- ---------------------------------------------------------------------------
-- A fixed block reserves time after itself, like everything else does
-- (spec §6.2 rule 3, §4.3, §4.4).
--
-- Cooldown was a property of a *task* and of the category it belongs to, which
-- covered the case where the work is what tires you out. It did not cover the
-- commoner one: a meeting across town, a hospital appointment, a call that
-- needs writing up. The twenty minutes after those is time nothing can be
-- scheduled into, and until now the only way to say so was to make the
-- appointment longer than it is — which is a lie the calendar then shows to
-- everybody, and which moves the appointment's own end.
--
-- Default zero, so every existing row means exactly what it meant before.
-- Non-negative, checked here rather than trusted: the column is read by the
-- solver, and a negative value would quietly *shorten* a block's footprint.
-- ---------------------------------------------------------------------------

ALTER TABLE appointments
  ADD COLUMN cooldown_min integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE appointments
  ADD CONSTRAINT appointments_cooldown_non_negative CHECK (cooldown_min >= 0);
--> statement-breakpoint

UPDATE app_meta SET value = 'm22' WHERE key = 'schema_version';
