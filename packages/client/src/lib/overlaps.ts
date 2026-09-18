import type { AvailabilityWindow, ActivityType } from '@ambitime/shared';

/**
 * Where two activity types claim the same hour (spec §4.3, §6.2 rule 1).
 *
 * Overlap is **legal and often deliberate** — "I could work or exercise at
 * seven" is a real thing to say, and the solver picks whichever task wins on
 * score. So this is a notice, never an error: nothing is refused, nothing is
 * corrected, and the only thing missing before was any way to find out.
 *
 * What makes it worth surfacing is that overlap is invisible in the editor.
 * Hours are edited one activity type at a time, so the screen that would show
 * the clash is the one screen that shows a single type — and a user setting
 * exercise to 07:00–09:00 has no way to know work already claims 08:00 unless
 * they remember. The consequence is not a broken schedule but a surprising one:
 * capacity that looks like two hours of exercise is one, because work took the
 * other.
 *
 * Reported per *rule* on the type being edited, so the editor can mark the row
 * a person is looking at rather than describe the clash somewhere else.
 */

export interface RuleOverlap {
  /** Which of the edited type's ranges clashes. */
  weekday: number;
  startMin: number;
  endMin: number;
  /** The other activity type, named for the notice. */
  otherName: string;
  /** The minutes both claim — what is actually contested. */
  sharedStartMin: number;
  sharedEndMin: number;
}

export interface OverlapInput {
  /** The rules on screen; these are what get marked. */
  rules: readonly { weekday: number; startMin: number; endMin: number }[];
  /** Every window in the planner, including the edited type's own. */
  availability: readonly AvailabilityWindow[];
  activityTypes: readonly ActivityType[];
  /** The type being edited — its own windows are not a clash with itself. */
  activityTypeId: string;
  /** `null` for the default set; otherwise the special week being edited. */
  weekTypeOverrideId: string | null;
}

/**
 * Every clash between the rules on screen and another type's hours.
 *
 * Compared **only within the same week type**. A holiday's hours replace the
 * default set rather than adding to it (§4.3), so a default Tuesday and a
 * holiday Tuesday are never both in force and reporting them as a clash would
 * be reporting two things that cannot happen together.
 */
export function overlappingRules({
  rules,
  availability,
  activityTypes,
  activityTypeId,
  weekTypeOverrideId,
}: OverlapInput): RuleOverlap[] {
  const names = new Map(activityTypes.map((activityType) => [activityType.id, activityType.name]));

  const others = availability.filter(
    (window) =>
      window.activityTypeId !== activityTypeId &&
      (window.weekTypeOverrideId ?? null) === weekTypeOverrideId,
  );

  const found: RuleOverlap[] = [];

  for (const rule of rules) {
    for (const other of others) {
      if (other.weekday !== rule.weekday) continue;

      // Half-open, like every interval in the system: 09:00–12:00 and
      // 12:00–17:00 abut and do not clash.
      const sharedStartMin = Math.max(rule.startMin, other.startMin);
      const sharedEndMin = Math.min(rule.endMin, other.endMin);
      if (sharedEndMin <= sharedStartMin) continue;

      found.push({
        weekday: rule.weekday,
        startMin: rule.startMin,
        endMin: rule.endMin,
        otherName: names.get(other.activityTypeId) ?? '',
        sharedStartMin,
        sharedEndMin,
      });
    }
  }

  return found;
}
