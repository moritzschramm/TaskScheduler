import type {
  CalendarSpec,
  FixedBlock,
  Instant,
  Placement,
  ResolvedWindow,
  Schedulable,
  ScheduleContext,
  SequenceSpec,
} from '../../src/index.js';

/**
 * Hand-built plain-data fixtures. The engine takes no infrastructure, so these
 * tests need none either — everything below is literals.
 *
 * `Date` appears here and nowhere in `src/`: converting a readable ISO literal
 * into the engine's integer-minute representation is a test-authoring
 * convenience, not something the engine itself is allowed to do.
 */

/** ISO-8601 instant → integer minutes since the epoch. */
export function at(iso: string): Instant {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO instant: ${iso}`);
  if (ms % 60_000 !== 0) throw new Error(`Instant is not minute-aligned: ${iso}`);
  return ms / 60_000;
}

export const CALENDAR: CalendarSpec = { id: 'cal-1', timeZone: 'Europe/Berlin' };
export const ACTIVITY_TYPE = 'cat-work';

/** Monday 2026-03-23, 09:00–17:00 Berlin time = 08:00–16:00 UTC (CET, UTC+1). */
export const MONDAY_WINDOW: ResolvedWindow = {
  ruleId: 'rule-mon',
  calendarId: CALENDAR.id,
  activityTypeId: ACTIVITY_TYPE,
  interval: { start: at('2026-03-23T08:00:00Z'), end: at('2026-03-23T16:00:00Z') },
};

/** Tuesday 2026-03-24, same wall-clock hours — a second, disjoint window. */
export const TUESDAY_WINDOW: ResolvedWindow = {
  ruleId: 'rule-tue',
  calendarId: CALENDAR.id,
  activityTypeId: ACTIVITY_TYPE,
  interval: { start: at('2026-03-24T08:00:00Z'), end: at('2026-03-24T16:00:00Z') },
};

let nextId = 0;

export function schedulable(overrides: Partial<Schedulable> = {}): Schedulable {
  nextId += 1;
  const id = overrides.occurrenceId ?? `occ-${String(nextId).padStart(3, '0')}`;
  return {
    taskId: `task-${id}`,
    calendarId: CALENDAR.id,
    activityTypeId: ACTIVITY_TYPE,
    durationMin: 60,
    cooldownMin: 0,
    ...overrides,
    // Last, so a caller-supplied id and the generated fallback cannot disagree.
    occurrenceId: id,
  };
}

export function placement(
  occurrenceId: string,
  startIso: string,
  durationMin: number,
  cooldownMin = 0,
): Placement {
  const start = at(startIso);
  return { occurrenceId, interval: { start, end: start + durationMin }, cooldownMin };
}

export function fixedBlock(
  id: string,
  startIso: string,
  endIso: string,
  cooldownMin = 0,
): FixedBlock {
  return {
    id,
    calendarId: CALENDAR.id,
    interval: { start: at(startIso), end: at(endIso) },
    // Omitted at zero, so the default fixture is exactly the shape a caller
    // that has never heard of block cooldowns produces.
    ...(cooldownMin === 0 ? {} : { cooldownMin }),
  };
}

export function sequence(id: string, isOrdered = false): SequenceSpec {
  return { id, isOrdered };
}

/** A context with sensible defaults; every field can be overridden per test. */
export function context(overrides: Partial<ScheduleContext> = {}): ScheduleContext {
  return {
    now: at('2026-03-23T06:00:00Z'),
    horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-30T00:00:00Z') },
    calendars: [CALENDAR],
    schedulables: [],
    fixedBlocks: [],
    windows: [MONDAY_WINDOW, TUESDAY_WINDOW],
    sequences: [],
    ...overrides,
  };
}

/** Reverses an array without touching the original, for order-insensitivity checks. */
export function reversed<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}
