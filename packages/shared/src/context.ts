import { z } from 'zod';
import type { ScheduleContext } from '@ambitime/scheduler';

/**
 * The solver's **input**, over the wire (spec §3.3).
 *
 * Every other read hands a client the schedule's answer. This one hands it the
 * question, so the client can run the same engine over the same facts and get
 * the same answer without asking — which is the whole point of an isomorphic
 * scheduler, and the thing M12 turns from a design property into a feature.
 *
 * Everything here is already plain data: integer minutes since the epoch, ids,
 * and small records. The engine was built that way (§6.3) so that a context is
 * serialisable and a solve is reproducible; nothing needs converting on either
 * side of the wire.
 *
 * The schema is *not* derived from the TypeScript types — those are structural
 * and a schema is a promise. `satisfies` at the bottom holds the two together:
 * if a field is added to `ScheduleContext` and not here, this file stops
 * compiling.
 */

const uuid = z.uuid();
/** The engine's instant: whole minutes since the epoch, never a string. */
const instant = z.int();
const minuteOfDay = z.int().min(0).max(1440);
const interval = z.object({ start: instant, end: instant });

const civilDate = z.object({
  year: z.int(),
  month: z.int().min(1).max(12),
  day: z.int().min(1).max(31),
});

const weekdayRange = z.object({
  weekday: z.int().min(1).max(7),
  startMin: minuteOfDay,
  endMin: minuteOfDay,
});

export const calendarSpecSchema = z.object({
  id: uuid,
  timeZone: z.string(),
  workingWindow: z.array(weekdayRange).optional(),
});

export const schedulableSchema = z.object({
  occurrenceId: uuid,
  taskId: uuid,
  calendarId: uuid,
  categoryId: uuid,
  durationMin: z.int(),
  cooldownMin: z.int(),
  dueDate: instant.optional(),
  dueKind: z.enum(['soft', 'hard']).optional(),
  manualFloor: instant.optional(),
  manualBias: instant.optional(),
  sequenceId: uuid.optional(),
  sequencePosition: z.int().optional(),
  priority: z.int().optional(),
  preferredRange: z.object({ startMin: minuteOfDay, endMin: minuteOfDay }).optional(),
  focusLevel: z.int().min(1).max(5).optional(),
});

export const engineFixedBlockSchema = z.object({
  /**
   * Not a uuid: an expanded instance of a recurring appointment (§8.1) is not a
   * row and has no id of its own, so it carries its template's plus which
   * instance it is. The engine reads a block's id only to order
   * deterministically (§6.3), and a composite is as stable as a uuid for that.
   */
  id: z.string().min(1),
  calendarId: uuid,
  interval,
  /** Reserved after the block; part of its footprint (§6.2 rule 3). */
  cooldownMin: z.int().nonnegative().optional(),
});

export const resolvedWindowSchema = z.object({
  ruleId: uuid,
  calendarId: uuid,
  categoryId: uuid,
  interval,
  focusLevel: z.int().min(1).max(5).optional(),
});

export const sequenceSpecSchema = z.object({ id: uuid, isOrdered: z.boolean() });

export const scheduleContextSchema = z.object({
  /**
   * The instant the server resolved the horizon against.
   *
   * Sent rather than taken from the browser's clock, and used verbatim by the
   * client's solve: two runs over the same facts at different `now`s are
   * legitimately different answers, and a client that substituted its own would
   * see a mismatch it could not explain (§6.3).
   */
  now: instant,
  horizon: interval,
  calendars: z.array(calendarSpecSchema),
  schedulables: z.array(schedulableSchema),
  fixedBlocks: z.array(engineFixedBlockSchema),
  windows: z.array(resolvedWindowSchema),
  sequences: z.array(sequenceSpecSchema),
});

export const contextResponseSchema = z.object({
  calendarId: uuid,
  context: scheduleContextSchema,
});

export type ScheduleContextWire = z.infer<typeof scheduleContextSchema>;
export type ContextResponse = z.infer<typeof contextResponseSchema>;

/**
 * A parsed context, as the engine will accept it.
 *
 * Two things happen here, and they are the same thing. Zod infers an optional
 * field as `T | undefined`, which under `exactOptionalPropertyTypes` is not
 * what `?: T` means — so a parsed context does not typecheck against
 * `ScheduleContext` even though every value in it is right. And a record
 * carrying `{ dueDate: undefined }` is not deep-equal to one that simply omits
 * it, which would make the determinism test fail on a difference that does not
 * exist.
 *
 * Dropping undefined-valued keys fixes both at once: absent and
 * present-but-undefined become one thing, which is what the engine already
 * treats them as. The cast is safe precisely because `compact` removes the
 * `| undefined` the compiler is objecting to.
 */
export function toEngineContext(parsed: ScheduleContextWire): ScheduleContext {
  return {
    now: parsed.now,
    horizon: parsed.horizon,
    calendars: parsed.calendars.map(compact),
    schedulables: parsed.schedulables.map(compact),
    fixedBlocks: parsed.fixedBlocks.map(compact),
    windows: parsed.windows.map(compact),
    sequences: parsed.sequences.map(compact),
  } as ScheduleContext;
}

/** A shallow copy without the keys whose value is `undefined`. */
export function compact<T extends object>(value: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) copy[key] = item;
  }
  return copy as T;
}

/** `civilDate` is exported for the week-type reads that will need it (§8.1). */
export const civilDateSchema = civilDate;
