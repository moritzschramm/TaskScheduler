-- ---------------------------------------------------------------------------
-- Two appointments may occupy the same hour (spec §5.3, §7.4).
--
-- The constraint said something true about a solver and false about a diary.
-- Rule 2 of §6.2 is that nothing the *scheduler* places may overlap a fixed
-- block, and that is untouched by this: a task still reflows around every
-- appointment, and the engine still treats the union of them as time that is
-- gone. What the constraint additionally forbade was a person recording two
-- things that genuinely do coincide — a conference that runs all week with
-- three sessions inside it, a phone call during a train journey, a day blocked
-- out that already had a meeting on it. Those are not data errors. Refusing
-- them made the calendar unable to describe an ordinary week.
--
-- It also refused them *badly*. The only way to report a violation of a GiST
-- exclusion is after the fact, and the sentence the command layer produced
-- named the calendar by its uuid, because a uuid is all the failure carries.
--
-- Nothing replaces it in application code. A read-then-write check would be a
-- weaker version of the same rule with a race in it, and the rule is the thing
-- being removed.
--
-- `btree_gist` stays installed: dropping an extension to tidy up is a risk
-- taken for nothing, and the next range constraint would only add it again.
-- ---------------------------------------------------------------------------

ALTER TABLE appointments DROP CONSTRAINT appointments_no_overlap_per_calendar;
--> statement-breakpoint

UPDATE app_meta SET value = 'm21' WHERE key = 'schema_version';
