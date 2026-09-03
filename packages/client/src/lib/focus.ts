import { language, translate, type MessageKey } from '@/i18n';

/**
 * Focus levels, in words (spec §4.4, §6.5).
 *
 * The engine compares integers — a task's `focus_level` against the window's
 * focus profile — and 1 is shallow, 5 is deep. On screen "Focus 1" through
 * "Focus 5" told a person nothing about which end was which, and got the
 * direction wrong as often as right: without a scale, a lower number reads as
 * *less* demanding to some people and *more* important to others.
 *
 * One vocabulary, exported, so the task editor and the window editor cannot
 * label the same number differently — which would be worse than no label,
 * because matching a task to a window is exactly what the number is for.
 *
 * The labels are message keys rather than words. A frozen array of English
 * would survive a language change and put "Very high focus" in the middle of a
 * German form; resolving at call time means the list is in whatever language is
 * in force when it is read.
 */
export interface FocusLevel {
  value: number;
  label: MessageKey;
}

export const FOCUS_LEVELS: readonly FocusLevel[] = [
  { value: 1, label: 'focus.veryLow' },
  { value: 2, label: 'focus.low' },
  { value: 3, label: 'focus.medium' },
  { value: 4, label: 'focus.high' },
  { value: 5, label: 'focus.veryHigh' },
] as const;

/** The word for a level, or the bare number if one ever falls outside the scale. */
export function focusLabel(level: number): string {
  const found = FOCUS_LEVELS.find((entry) => entry.value === level);
  return found === undefined ? String(level) : translate(language.value, found.label);
}
