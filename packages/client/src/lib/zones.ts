/**
 * The IANA time zones the runtime knows, worked out once.
 *
 * `Intl.supportedValuesOf('timeZone')` builds a fresh array of some four
 * hundred strings on every call, and three separate selects on the settings
 * page were each calling it. The list cannot change while the page is open, so
 * it is computed on first use and shared.
 *
 * The DOM cost is the larger one — four hundred `<option>` elements per select
 * — which is why the pickers that are folded away render theirs only once
 * opened.
 */
let cached: readonly string[] | null = null;

export function timeZones(): readonly string[] {
  cached ??= Intl.supportedValuesOf('timeZone');
  return cached;
}

/**
 * The same list, with `current` in it even if the runtime has never heard of
 * it — a calendar configured elsewhere must not have its zone silently
 * rewritten by a picker that cannot show it.
 */
export function timeZonesIncluding(current: string): readonly string[] {
  const known = timeZones();
  return known.includes(current) ? known : [current, ...known];
}

/** The viewer's own zone — a good default for something new. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
