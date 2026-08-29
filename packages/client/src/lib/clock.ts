/**
 * Where the client's `now` comes from.
 *
 * The same argument as the server's injected clock: `now` decides which week
 * opens and which slots have passed, and reading `Date` inline puts that
 * decision somewhere no test can reach and no caller can see.
 *
 * M12 needs this for a second reason. The scheduler takes `now` as an explicit
 * input (§6.3), so the optimistic client-side solve has to be handed one — and
 * it must be the same `now` the view is drawing against, or the proposal and
 * the grid disagree by however long the page has been open.
 */

let source: () => Date = () => new Date();

export function now(): Date {
  return source();
}

/** Pins the clock. Tests only; production never calls it. */
export function setClock(next: () => Date): void {
  source = next;
}

export function resetClock(): void {
  source = () => new Date();
}
