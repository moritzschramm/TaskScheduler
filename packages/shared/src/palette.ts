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
 * order as activity types are created, and once all eight are spoken for the
 * assignment starts round again on the least-used one.
 *
 * **That reuse was refused at first, and the refusal was worse.** Two things
 * the same colour is a statement that they are related, so a ninth type used to
 * start with no colour at all — which is also a statement, and a stranger one:
 * that this type is not the kind of thing that has a colour. What it produced
 * on screen was a lane the eye reads as unavailable time. Given that nothing
 * here uses colour as the identity channel (see below), a shared hue costs a
 * grouping cue and an absent one costs the reader a false signal.
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
 * The **first least-used** slot, which while any is free is exactly "the first
 * free one in palette order" — so the first three types still get the three
 * that separate for every reader, and a gap left by a recolouring is still
 * filled rather than counted past. Past the eighth it spreads the reuse evenly
 * instead of piling every later type onto blue.
 *
 * Always answers. Every activity type has a colour; see the note above for why
 * "none" turned out to be the worse of the two things a ninth type could say.
 */
export function nextCategoryColor(taken: readonly (string | null)[]): CategoryColor {
  const used = new Map<CategoryColor, number>(CATEGORY_COLORS.map((color) => [color, 0]));
  for (const value of taken) {
    if (isCategoryColor(value)) used.set(value, (used.get(value) ?? 0) + 1);
  }

  let fewest: CategoryColor = CATEGORY_COLORS[0];
  for (const color of CATEGORY_COLORS) {
    if ((used.get(color) ?? 0) < (used.get(fewest) ?? 0)) fewest = color;
  }

  return fewest;
}

/** Whether a stored value is still one of the slots. */
export function isCategoryColor(value: unknown): value is CategoryColor {
  return typeof value === 'string' && (CATEGORY_COLORS as readonly string[]).includes(value);
}
