-- ---------------------------------------------------------------------------
-- Every activity type has a colour (spec §4.3).
--
-- The colour was nullable and the null meant two different things depending on
-- where you stood. On the picker it read as an offer — "no colour" — which
-- nobody wants and which put a type's hours on the grid as a grey lane the eye
-- reads as unavailable time. In the assignment it meant "the palette ran out",
-- because slots were never reused past the eighth.
--
-- Reuse is the better of the two answers, and `nextCategoryColor` now gives it.
-- This backfills what the old rule left behind: the uncoloured rows take the
-- slots after the ones their tenant already uses, in creation order, wrapping
-- round the palette. Deterministic, so a re-run cannot produce a different
-- calendar.
--
-- The column stays nullable on purpose. Undo restores row images (§12), and an
-- image written before this migration can carry a null; a NOT NULL here would
-- turn "take that back" into a constraint violation. What has changed is that
-- nothing *writes* one any more.
-- ---------------------------------------------------------------------------

WITH palette AS (
  SELECT color, position
    FROM unnest(ARRAY['blue','orange','aqua','yellow','magenta','green','violet','red'])
      WITH ORDINALITY AS p(color, position)
),
uncoloured AS (
  SELECT c.id,
         (SELECT count(*)
            FROM categories used
           WHERE used.tenant_id = c.tenant_id
             AND used.color IS NOT NULL)
         + row_number() OVER (PARTITION BY c.tenant_id ORDER BY c.created_at, c.id)
         - 1 AS slot
    FROM categories c
   WHERE c.color IS NULL
)
UPDATE categories c
   SET color = p.color
  FROM uncoloured u
  JOIN palette p ON p.position = (u.slot % 8) + 1
 WHERE c.id = u.id;
--> statement-breakpoint

UPDATE app_meta SET value = 'm23' WHERE key = 'schema_version';
