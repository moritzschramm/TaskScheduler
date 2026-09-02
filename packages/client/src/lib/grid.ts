import type {
  CalendarConfiguration,
  CompletedBlock,
  FixedBlock,
  ScheduledBlock,
} from '@ambitime/shared';
import {
  resolveWindows,
  wallClockToInstant,
  type AvailabilityRule,
  type CivilDate,
  type ResolvedWindow,
  type WeekdayRange,
  type WeekTypeOverride,
} from '@ambitime/scheduler';
import {
  addDays,
  formatMinuteOfDay,
  localDate,
  minuteOfDay,
  parseCivilDate,
  sameCivilDate,
  toInstant,
  toIso,
} from './time';

/**
 * Placing blocks on a week grid (plan M10; spec §13).
 *
 * Kept out of the component on purpose: where a block sits is arithmetic, and
 * arithmetic is testable without mounting anything. What the component does
 * with the result — CSS, colours, focus rings — is a separate question from
 * whether 09:00 Berlin lands 540 minutes down the Monday column.
 *
 * **Every position is a local wall-clock minute**, derived in the calendar's
 * own zone. A block is placed by the clock a person reads, not by its UTC
 * offset, which is what makes the DST weekends render as ordinary working days.
 */

export interface GridBlock {
  key: string;
  title: string;
  /** Minutes from local midnight to the block's start. */
  startMin: number;
  /** Minutes from local midnight to its end, clipped to the day. */
  endMin: number;
  /** The cooldown that follows it (§6.2 rule 3); drawn, not scheduled. */
  cooldownMin: number;
  kind: 'task' | 'appointment' | 'unavailability' | 'completed';
  label: string;
  taskId?: string;
  appointmentId?: string;
  /** True when the block began before this day, or runs past its end. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** A stretch of one local day, in minutes since its midnight. */
export interface DayBand {
  startMin: number;
  endMin: number;
}

const MINUTES_PER_DAY = 1440;

/**
 * Pixels per minute. One number, shared by the layout and the drag arithmetic,
 * so what a user sees and what a drop means cannot disagree.
 */
export const SCALE = 1.1;

/**
 * The drag grid of spec §13: "UI drag grid snaps to 15-minute blocks; a text
 * field allows exact minutes."
 *
 * Two affordances, deliberately. Snapping makes the common case fast and the
 * result tidy; the text field is the escape hatch for the case snapping cannot
 * express, and it is also the keyboard-accessible path (§14) for a gesture that
 * would otherwise need a mouse.
 */
export const SNAP_MINUTES = 15;

/** Rounds to the nearest 15 minutes; ties go later, as dragging down suggests. */
export function snapToGrid(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

/**
 * A drag's pixel delta as a snapped minute offset.
 *
 * Kept here rather than in the component because it is arithmetic, and
 * arithmetic in a component can only be tested by mounting one.
 */
export function dragOffsetMinutes(deltaPixels: number): number {
  return snapToGrid(deltaPixels / SCALE);
}

/**
 * The stretches of `day` an availability window covers, merged (spec §4.3, §9.1).
 *
 * **This is what makes the grid readable as a calendar.** Without it every hour
 * of every day looks equally available, so a week with nothing placed in it is
 * indistinguishable from a week that could not have anything placed in it — and
 * those two need very different things from the user.
 *
 * Every category's windows go into one union, because the question the grid
 * asks is "could anything be scheduled here", not "could this particular kind
 * of thing". Drawing them per category would also shade an overlap twice, and
 * with a translucent fill twice is a different colour.
 *
 * The windows are already resolved: the engine expanded the weekday rules onto
 * real dates, applied any week-type override, and clipped the result to the
 * calendar's working window. Re-deriving any of that here would give the grid a
 * second opinion about when the user is available.
 */
export function openBandsForDay(
  day: CivilDate,
  timeZone: string,
  windows: readonly ResolvedWindow[],
): DayBand[] {
  const bands: DayBand[] = [];

  for (const window of windows) {
    const positioned = position(
      day,
      timeZone,
      toIso(window.interval.start),
      toIso(window.interval.end),
    );
    if (positioned !== undefined) {
      bands.push({ startMin: positioned.startMin, endMin: positioned.endMin });
    }
  }

  return mergeBands(bands);
}

function mergeBands(bands: DayBand[]): DayBand[] {
  const sorted = [...bands].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const merged: DayBand[] = [];

  for (const band of sorted) {
    const last = merged.at(-1);

    // Touching counts as overlapping. "09:00-12:00" and "12:00-17:00" are one
    // working day, and a seam drawn at noon would read as a break that is not
    // there.
    if (last !== undefined && band.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, band.endMin);
      continue;
    }

    merged.push({ ...band });
  }

  return merged;
}

/**
 * The windows governing the week on screen, resolved by the engine.
 *
 * **Not the ones on the schedule context.** Those are resolved against the
 * *placeable* horizon, which starts at `now` and ends a fortnight out — so
 * shading from them would draw this morning as closed because it has passed,
 * and every week the user pages back to as closed entirely. Neither is a fact
 * about the calendar; both are facts about the horizon.
 *
 * The rules themselves have no such edge, so they are resolved here for the
 * seven days actually being drawn. It is the engine's own `resolveWindows` that
 * does it, over the configuration the settings screen edits — the week-type
 * overrides and the working-window clip come free, and the grid cannot end up
 * with a second opinion about when the user is available (§3.3).
 */
export function windowsForWeek(
  days: readonly CivilDate[],
  timeZone: string,
  calendarId: string,
  configuration: CalendarConfiguration,
): ResolvedWindow[] {
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined) return [];

  const working: WeekdayRange[] = configuration.windows
    .filter((window) => window.kind === 'working')
    .map(({ weekday, startMin, endMin }) => ({ weekday, startMin, endMin }));

  const rules: AvailabilityRule[] = configuration.availability.map((window) => ({
    id: window.id,
    calendarId,
    categoryId: window.categoryId,
    weekday: window.weekday,
    startMin: window.startMin,
    endMin: window.endMin,
    // Absent rather than null, matching the server's loader: under
    // `exactOptionalPropertyTypes` "no override" and "an override that is
    // undefined" are different things, and only the first is meant.
    ...(window.weekTypeOverrideId === null
      ? {}
      : { weekTypeOverrideId: window.weekTypeOverrideId }),
    ...(window.focusLevel === null ? {} : { focusLevel: window.focusLevel }),
  }));

  const overrides: WeekTypeOverride[] = configuration.weekTypeOverrides.map((override) => ({
    id: override.id,
    calendarId,
    startDate: parseCivilDate(override.startDate),
    endDate: parseCivilDate(override.endDate),
  }));

  return resolveWindows({
    horizon: {
      start: wallClockToInstant(first, 0, timeZone),
      end: wallClockToInstant(addDays(last, 1), 0, timeZone),
    },
    // Absent is unrestricted and `[]` is "nothing may be placed" (§9.1), so a
    // calendar that has never had a working window set must not send an empty
    // one — that would shade the whole week closed on the strength of a
    // setting nobody made.
    calendars: [
      { id: calendarId, timeZone, ...(working.length === 0 ? {} : { workingWindow: working }) },
    ],
    rules,
    overrides,
  });
}

/**
 * A band clipped to the visible span, or `null` if it falls entirely outside.
 *
 * The grid draws a slice of the day (06:00–22:00 by default) while a window may
 * run from midnight. Unclipped, a band would be positioned at a negative offset
 * and paint over the day headings.
 */
export function clipBand(band: DayBand, dayStartMin: number, dayEndMin: number): DayBand | null {
  const startMin = Math.max(band.startMin, dayStartMin);
  const endMin = Math.min(band.endMin, dayEndMin);
  return endMin <= startMin ? null : { startMin, endMin };
}

/**
 * Where a block would start after being moved by `offsetMinutes`, clamped to
 * the day it is drawn on.
 *
 * Clamped rather than allowed to overflow: a block dragged off the top of a
 * column has not been moved to the previous day — the user was reaching for
 * 06:00 and overshot — and silently rescheduling it a day earlier is a
 * surprising answer to a slip of the hand.
 */
export function movedStartMin(block: GridBlock, offsetMinutes: number, dayStartMin = 0): number {
  const duration = block.endMin - block.startMin;
  const latest = MINUTES_PER_DAY - duration;
  return Math.min(Math.max(block.startMin + offsetMinutes, dayStartMin), Math.max(latest, 0));
}

/**
 * The blocks belonging to one local day, positioned.
 *
 * A block spanning midnight appears on **both** days, clipped to each and
 * flagged, rather than being assigned to whichever day it started on. A
 * calendar that dropped the second half of an overnight block would be lying
 * about the morning.
 */
export function blocksForDay(
  day: CivilDate,
  timeZone: string,
  scheduled: readonly ScheduledBlock[],
  fixed: readonly FixedBlock[],
  completed: readonly CompletedBlock[] = [],
): GridBlock[] {
  const blocks: GridBlock[] = [];

  for (const block of scheduled) {
    const positioned = position(day, timeZone, block.start, block.end);
    if (!positioned) continue;

    blocks.push({
      key: `task-${block.occurrenceId}`,
      title: block.title,
      ...positioned,
      cooldownMin: block.cooldownMin,
      kind: 'task',
      label: `${formatMinuteOfDay(positioned.startMin)}–${formatMinuteOfDay(positioned.endMin)}`,
      taskId: block.taskId,
    });
  }

  for (const block of fixed) {
    const positioned = position(day, timeZone, block.start, block.end);
    if (!positioned) continue;

    blocks.push({
      key: `appointment-${block.appointmentId}`,
      // §7.4: an unavailability is content-free and the server stores no title,
      // so the label is the client's to supply rather than the database's.
      title: block.isUnavailability ? 'Unavailable' : block.title,
      ...positioned,
      cooldownMin: 0,
      kind: block.isUnavailability ? 'unavailability' : 'appointment',
      label: `${formatMinuteOfDay(positioned.startMin)}–${formatMinuteOfDay(positioned.endMin)}`,
      appointmentId: block.appointmentId,
    });
  }

  for (const block of completed) {
    const positioned = position(day, timeZone, block.start, block.end);
    if (!positioned) continue;

    blocks.push({
      key: `completed-${block.occurrenceId}`,
      title: block.title,
      ...positioned,
      cooldownMin: 0,
      kind: 'completed',
      label: `${formatMinuteOfDay(positioned.startMin)}–${formatMinuteOfDay(positioned.endMin)}`,
      taskId: block.taskId,
    });
  }

  // Earliest first, then by title, so two runs render identically — the same
  // determinism rule the engine holds itself to (§6.3).
  return blocks.sort(
    (a, b) =>
      a.startMin - b.startMin || a.title.localeCompare(b.title) || a.key.localeCompare(b.key),
  );
}

/**
 * Where a `[start, end)` interval sits on `day`, or `undefined` if it misses.
 *
 * The comparison is done on local *dates*, not by converting the day to a UTC
 * range: a day is 23 or 25 hours long twice a year, and treating it as 1440
 * minutes of UTC would misplace everything on those two days.
 */
function position(
  day: CivilDate,
  timeZone: string,
  startIso: string,
  endIso: string,
):
  | { startMin: number; endMin: number; continuesBefore: boolean; continuesAfter: boolean }
  | undefined {
  const startDay = localDate(startIso, timeZone);
  const endInstant = toInstant(endIso);
  // A block ending exactly at midnight belongs to the day it ran through, not
  // to the one it touches: the interval is half-open (§6.3).
  const endDay = localDate(toIsoMinuteBefore(endInstant), timeZone);

  const startsHere = sameCivilDate(startDay, day);
  const endsHere = sameCivilDate(endDay, day);
  const spansHere = isBetween(day, startDay, endDay);

  if (!startsHere && !endsHere && !spansHere) return undefined;

  return {
    startMin: startsHere ? minuteOfDay(startIso, timeZone) : 0,
    endMin: endsHere ? endMinuteOnDay(endIso, timeZone) : MINUTES_PER_DAY,
    continuesBefore: !startsHere,
    continuesAfter: !endsHere,
  };
}

/**
 * An end at local midnight reads as 1440 on the day it closes, not 0.
 *
 * Zero would collapse the block to nothing at the top of a day it never
 * touched — the classic half-open-interval rendering bug.
 */
function endMinuteOnDay(endIso: string, timeZone: string): number {
  const minutes = minuteOfDay(endIso, timeZone);
  return minutes === 0 ? MINUTES_PER_DAY : minutes;
}

function toIsoMinuteBefore(instant: number): string {
  return new Date((instant - 1) * 60_000).toISOString();
}

function isBetween(day: CivilDate, first: CivilDate, last: CivilDate): boolean {
  const value = key(day);
  return value > key(first) && value < key(last);
}

function key(date: CivilDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}
