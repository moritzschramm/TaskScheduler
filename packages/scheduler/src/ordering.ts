/**
 * Determinism utilities (spec §6.3).
 *
 * Determinism is a hard requirement: the client computes an optimistic schedule
 * and the server computes the authoritative one, and they must agree. Equal
 * inputs have to produce equal output *including tie-breaks*, so no ordering in
 * the engine may depend on the order rows happened to arrive in.
 *
 * Every comparator here is a **total** order — it ends in an entity id, so no
 * two distinct items ever compare equal and array sort stability never matters.
 */

export type Comparator<T> = (a: T, b: T) => number;

/**
 * Compares integers. Named to make the intent visible at call sites: spec §6.3
 * forbids floating-point values from participating in comparisons that decide
 * placement, and every value the engine compares is an integer minute.
 */
export function compareInts(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lexicographic string comparison, used only for the final id tie-break. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sorts `undefined` last, so an absent optional (no due date, no priority) never
 * wins a comparison it should not participate in.
 */
export function compareOptionalInts(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return compareInts(a, b);
}

/** Composes comparators lexicographically: the first non-zero result wins. */
export function chain<T>(...comparators: Comparator<T>[]): Comparator<T> {
  return (a, b) => {
    for (const comparator of comparators) {
      const result = comparator(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** Reverses a comparator, for descending orders. */
export function descending<T>(comparator: Comparator<T>): Comparator<T> {
  return (a, b) => -comparator(a, b);
}

/** Orders by a derived integer key. */
export function byInt<T>(key: (item: T) => number): Comparator<T> {
  return (a, b) => compareInts(key(a), key(b));
}

/** Orders by a derived optional integer key, absent values last. */
export function byOptionalInt<T>(key: (item: T) => number | undefined): Comparator<T> {
  return (a, b) => compareOptionalInts(key(a), key(b));
}

/** Orders by a derived id, the tie-break every total order ends in. */
export function byId<T>(key: (item: T) => string): Comparator<T> {
  return (a, b) => compareIds(key(a), key(b));
}

/**
 * Sorts a copy rather than in place.
 *
 * The engine never mutates its inputs — a caller passing the same array to two
 * solves must get the same answer twice, and an in-place sort would silently
 * make the second call's input differ from the first's.
 */
export function sorted<T>(items: readonly T[], comparator: Comparator<T>): T[] {
  return [...items].sort(comparator);
}

/**
 * Asserts that a comparator is total over `items` — that no two distinct
 * elements compare equal.
 *
 * A comparator that ties is the exact failure mode that makes client and server
 * disagree: both sort correctly, both produce a different valid order, and the
 * schedules diverge. Used by the determinism tests, and cheap enough to call
 * from a debug build.
 */
export function findOrderingTies<T>(items: readonly T[], comparator: Comparator<T>): Array<[T, T]> {
  const ties: Array<[T, T]> = [];
  const ordered = sorted(items, comparator);

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (comparator(previous, current) === 0) ties.push([previous, current]);
  }

  return ties;
}
