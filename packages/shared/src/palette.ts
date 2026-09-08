/**
 * The colours an activity type can be given (spec §4.3).
 *
 * **Slots, not free hex.** A colour picker lets somebody choose a yellow that
 * vanishes on a white grid or a grey they cannot tell from unavailable time,
 * and it has no answer at all for dark mode — one value cannot be right on both
 * surfaces. A slot is a *name*; each mode renders its own step for it, and both
 * steps were selected together.
 *
 * The eight hues and their two steps are taken unchanged from the reference
 * categorical palette, in its documented order. Slots are assigned in that
 * order as activity types are created and never cycled: a ninth type starts
 * with no colour rather than quietly reusing the first, because two things the
 * same colour is a statement that they are related.
 *
 * **What the validator says, plainly.** Run over all eight at once against
 * every pair, this palette fails: the worst pair (orange against red) is ΔE 7.1
 * to normal vision, and orange against green is ΔE 3.2 under protanopia. Only
 * four of the eight clear every pair in both modes. That is not a defect in the
 * palette — no eight hues clear an all-pairs test — and it is the reason
 * **nothing here uses colour as the identity channel**. Every band on the grid
 * carries its activity type's name, and the colour groups what the name
 * already says. A reader who cannot separate two hues reads two labels.
 *
 * The first three slots do clear all pairs in both modes, which is why the
 * assignment order matters: somebody with three activity types gets three
 * colours that are distinct for everyone, without choosing anything.
 */

export const CATEGORY_COLORS = [
  'blue',
  'orange',
  'aqua',
  'yellow',
  'magenta',
  'green',
  'violet',
  'red',
] as const;

export type CategoryColor = (typeof CATEGORY_COLORS)[number];

export interface ColorSteps {
  /** The step selected for the light surface. */
  light: string;
  /** Not a flip of the light one — its own step, selected for the dark surface. */
  dark: string;
}

export const CATEGORY_COLOR_STEPS: Readonly<Record<CategoryColor, ColorSteps>> = {
  blue: { light: '#2a78d6', dark: '#3987e5' },
  orange: { light: '#eb6834', dark: '#d95926' },
  aqua: { light: '#1baf7a', dark: '#199e70' },
  yellow: { light: '#eda100', dark: '#c98500' },
  magenta: { light: '#e87ba4', dark: '#d55181' },
  green: { light: '#008300', dark: '#008300' },
  violet: { light: '#4a3aa7', dark: '#9085e9' },
  red: { light: '#e34948', dark: '#e66767' },
};

/**
 * The slot a newly created activity type takes.
 *
 * Fixed order over the colours already spoken for, so the first three types get
 * the three that separate for every reader. Returns `null` past the eighth
 * rather than starting again — see the note above about what reuse would claim.
 */
export function nextCategoryColor(taken: readonly (string | null)[]): CategoryColor | null {
  const used = new Set(taken);
  return CATEGORY_COLORS.find((color) => !used.has(color)) ?? null;
}

/** Whether a stored value is still one of the slots. */
export function isCategoryColor(value: unknown): value is CategoryColor {
  return typeof value === 'string' && (CATEGORY_COLORS as readonly string[]).includes(value);
}
