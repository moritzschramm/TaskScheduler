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
 */
export interface FocusLevel {
  value: number;
  label: string;
}

export const FOCUS_LEVELS: readonly FocusLevel[] = [
  { value: 1, label: 'Very low focus' },
  { value: 2, label: 'Low focus' },
  { value: 3, label: 'Medium focus' },
  { value: 4, label: 'High focus' },
  { value: 5, label: 'Very high focus' },
] as const;

/** The word for a level, or the bare number if one ever falls outside the scale. */
export function focusLabel(level: number): string {
  return FOCUS_LEVELS.find((entry) => entry.value === level)?.label ?? String(level);
}
