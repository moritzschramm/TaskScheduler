-- ---------------------------------------------------------------------------
-- A colour per activity type (spec §4.3).
--
-- The grid draws each type's schedulable hours in its own colour, so somebody
-- looking at a week can see *what kind of thing* fits where rather than only
-- that something does. Until now every open hour was the same neutral shade and
-- the answer to "when could I exercise" was a settings screen.
--
-- Stored as a **slot name**, not a hex value. The two are not equivalent: one
-- hex cannot be right on both a light and a dark surface, and a free-form value
-- lets a user pick something invisible against the grid. A name is resolved to
-- a step per mode by the client, and the CHECK keeps the column to the eight
-- the palette actually defines — so a renamed or dropped slot fails loudly at
-- the write rather than rendering as nothing.
--
-- Nullable on purpose. The slots do not cycle, so a ninth activity type has no
-- colour, and that is a state the grid draws (in the old neutral shade) rather
-- than a value somebody forgot to set.
-- ---------------------------------------------------------------------------

ALTER TABLE categories ADD COLUMN color text;--> statement-breakpoint

ALTER TABLE categories
  ADD CONSTRAINT categories_color_is_a_palette_slot
  CHECK (color IS NULL OR color IN
    ('blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'));--> statement-breakpoint

-- Existing types get slots in the palette's own order, oldest first, so an
-- account that already has three keeps the three that separate for every
-- reader. Past the eighth they stay null, exactly as a new one would.
WITH ordered AS (
  SELECT id,
         tenant_id,
         row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS position
    FROM categories
)
UPDATE categories AS c
   SET color = (ARRAY['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'])[ordered.position]
  FROM ordered
 WHERE c.id = ordered.id
   AND ordered.position <= 8;--> statement-breakpoint

UPDATE app_meta SET value = 'm19' WHERE key = 'schema_version';
