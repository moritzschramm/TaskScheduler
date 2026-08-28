import { byId, byInt, byOptionalInt, chain, sorted } from './ordering.js';
import type { InfeasibilityReason } from './diagnostics.js';
import type { Instant } from './time.js';
import type { Placement, Schedulable, ScheduleContext, SequenceSpec } from './types.js';

/**
 * Uninterruptible sequences (spec §6.2 rule 5).
 *
 * A sequence is placed by **collapsing it to a composite**: one synthetic
 * schedulable whose duration is the summed member durations plus the cooldowns
 * *between* them. The composite goes through the ordinary solver — the same
 * hard filters, the same scoring — and once it has a slot it is expanded back
 * into one placement per member at a fixed offset.
 *
 * The point of the collapse is that contiguity then holds by construction
 * rather than by a check the solver has to remember to make: there is no
 * intermediate state in which half a sequence is placed, and nothing can be
 * wedged between two members because the whole span is committed at once.
 *
 * A lone task is a composite of one, so the solver has a single kind of thing
 * to place.
 */

/** A member of a placement unit, at a fixed offset from the block's start. */
export interface SequenceMember {
  schedulable: Schedulable;
  /** Minutes from the block start at which this member begins. */
  startOffset: number;
}

/**
 * One thing the solver places: a lone task, or a whole sequence.
 *
 * The composite is what scoring and the hard filters see; `members` is what the
 * result expands back into.
 */
export interface PlacementUnit {
  /** The occurrence id for a lone task, `sequence:<id>` for a block. */
  id: string;
  composite: Schedulable;
  members: SequenceMember[];
  sequenceId?: string;
  /**
   * Set when the unit cannot be placed no matter what the calendar looks like,
   * so the solver can name the reason instead of searching for a slot that
   * cannot exist.
   */
  blocked?: InfeasibilityReason;
}

/** The prefix distinguishing a composite's id from any real occurrence id. */
export const SEQUENCE_ID_PREFIX = 'sequence:';

/**
 * Every sequence the context refers to, declared or not.
 *
 * The database has a foreign key from `tasks.sequence_id`, so a member without
 * a declared sequence should not occur — but if one ever did, silently treating
 * its members as independent tasks would drop a hard constraint. An undeclared
 * sequence is therefore treated as unordered, which is the weaker of the two
 * forms and never invents an ordering the user did not ask for. The validator
 * resolves sequences the same way, so the two always agree on what exists.
 */
export function resolveSequences(context: ScheduleContext): Map<string, SequenceSpec> {
  const specs = new Map<string, SequenceSpec>();

  for (const sequence of context.sequences) specs.set(sequence.id, sequence);
  for (const schedulable of context.schedulables) {
    const { sequenceId } = schedulable;
    if (sequenceId !== undefined && !specs.has(sequenceId)) {
      specs.set(sequenceId, { id: sequenceId, isOrdered: false });
    }
  }

  return specs;
}

/** Ordered sequences follow `sequencePosition`; a member without one sorts last. */
const orderedMembers = chain<Schedulable>(
  byOptionalInt((schedulable) => schedulable.sequencePosition),
  byId((schedulable) => schedulable.occurrenceId),
);

/**
 * Unordered sequences are placed shortest-cooldown-first, so the **largest
 * cooldown ends up last**.
 *
 * Only the cooldowns *between* members count toward the span that has to fit
 * inside a window; the final member's cooldown trails the block and, like any
 * task's, is reserved against other tasks rather than against the window edge.
 * Pushing the longest cooldown to the end therefore makes the block fit the
 * most windows, and costs nothing — the user did not ask for an order, so the
 * engine picks the one that is easiest to schedule.
 */
const unorderedMembers = chain<Schedulable>(
  byInt((schedulable) => schedulable.cooldownMin),
  byId((schedulable) => schedulable.occurrenceId),
);

/**
 * Groups the context's schedulables into the units the solver places.
 *
 * Returned in id order. The solver re-sorts by score, but a stable starting
 * order keeps that sort's tie-breaks reproducible (spec §6.3).
 */
export function buildPlacementUnits(context: ScheduleContext): PlacementUnit[] {
  const specs = resolveSequences(context);
  const grouped = new Map<string, Schedulable[]>();
  const units: PlacementUnit[] = [];

  for (const schedulable of context.schedulables) {
    const { sequenceId } = schedulable;
    if (sequenceId === undefined) {
      units.push({
        id: schedulable.occurrenceId,
        composite: schedulable,
        members: [{ schedulable, startOffset: 0 }],
      });
      continue;
    }

    const members = grouped.get(sequenceId);
    if (members) members.push(schedulable);
    else grouped.set(sequenceId, [schedulable]);
  }

  for (const [sequenceId, members] of grouped) {
    units.push(sequenceUnit(sequenceId, specs.get(sequenceId)?.isOrdered ?? false, members));
  }

  return sorted(
    units,
    byId((unit) => unit.id),
  );
}

function sequenceUnit(
  sequenceId: string,
  isOrdered: boolean,
  rawMembers: readonly Schedulable[],
): PlacementUnit {
  const ordered = sorted(rawMembers, isOrdered ? orderedMembers : unorderedMembers);

  const members: SequenceMember[] = [];
  let offset = 0;
  for (const schedulable of ordered) {
    members.push({ schedulable, startOffset: offset });
    // The next member starts where this one's footprint ends — its duration
    // plus its non-compressible cooldown (§6.2 rule 3). This is exactly the
    // contiguity the validator checks for.
    offset += schedulable.durationMin + schedulable.cooldownMin;
  }

  const last = members[members.length - 1]!;
  const durationMin = last.startOffset + last.schedulable.durationMin;
  const blocked = structuralBlock(members);

  return {
    id: `${SEQUENCE_ID_PREFIX}${sequenceId}`,
    sequenceId,
    composite: compositeSchedulable(sequenceId, members, durationMin, last.schedulable.cooldownMin),
    members,
    ...(blocked === undefined ? {} : { blocked }),
  };
}

/**
 * Reasons a sequence can never be placed, whatever the calendar holds.
 *
 * Members in different categories are the important one: rule 5 requires a
 * single window, and windows belong to exactly one category, so no window can
 * hold the block. Left undetected the composite would be placed in the *first*
 * member's window and every other member would land outside its own category's
 * availability — a hard-constraint violation the solver itself created.
 */
function structuralBlock(members: readonly SequenceMember[]): InfeasibilityReason | undefined {
  const first = members[0]!.schedulable;
  const mixed = members.some(
    ({ schedulable }) =>
      schedulable.calendarId !== first.calendarId || schedulable.categoryId !== first.categoryId,
  );

  return mixed ? 'sequence_members_incompatible' : undefined;
}

/**
 * The synthetic schedulable representing the whole block.
 *
 * Hard constraints are translated **exactly**: a member's due date or manual
 * floor applies to that member's own interval, and because every member sits at
 * a fixed offset from the block start, each becomes a bound on where the block
 * may start. Taking the tightest of those bounds and re-expressing it in the
 * composite's own terms means the ordinary slot filter enforces every member's
 * constraint without knowing sequences exist.
 *
 * Soft attributes are combined by judgement, since the spec does not say how a
 * block inherits its members' preferences — see the note on each.
 */
function compositeSchedulable(
  sequenceId: string,
  members: readonly SequenceMember[],
  durationMin: number,
  cooldownMin: number,
): Schedulable {
  const first = members[0]!.schedulable;

  // A member ending at `startOffset + durationMin` after the block start must
  // finish by its due date, so the block must start by `due − thatOffset`.
  let hardStartLimit: number | undefined;
  let softStartLimit: number | undefined;
  // A member starting at `startOffset` must not begin before its floor, so the
  // block must start at or after `floor − startOffset`.
  let startFloor: number | undefined;

  for (const { schedulable, startOffset } of members) {
    if (schedulable.dueDate !== undefined) {
      const limit = schedulable.dueDate - (startOffset + schedulable.durationMin);
      if (schedulable.dueKind === 'hard') {
        hardStartLimit = hardStartLimit === undefined ? limit : Math.min(hardStartLimit, limit);
      } else {
        softStartLimit = softStartLimit === undefined ? limit : Math.min(softStartLimit, limit);
      }
    }

    if (schedulable.manualFloor !== undefined) {
      const floor = schedulable.manualFloor - startOffset;
      startFloor = startFloor === undefined ? floor : Math.max(startFloor, floor);
    }
  }

  // A hard due date binds and a soft one only scores, so when both are present
  // the hard bound is the composite's. The soft one is then not reflected in
  // urgency, which costs a little ordering pressure and no correctness.
  const due =
    hardStartLimit !== undefined
      ? { dueDate: hardStartLimit + durationMin, dueKind: 'hard' as const }
      : softStartLimit !== undefined
        ? { dueDate: softStartLimit + durationMin, dueKind: 'soft' as const }
        : undefined;

  // Priority and focus take the maximum: a block is as urgent as its most
  // important member, and needs a window deep enough for its most demanding one.
  const priority = maxDefined(members, ({ schedulable }) => schedulable.priority);
  const focusLevel = maxDefined(members, ({ schedulable }) => schedulable.focusLevel);

  // The first member that states a preference speaks for the block, since the
  // block starts where that member does. A preference stated by a later member
  // is off by its offset; it is a soft term, and inventing a combined range
  // would be less honest than deferring to one member's.
  const preferred = members.find(({ schedulable }) => schedulable.preferredRange !== undefined);
  const biased = members.find(({ schedulable }) => schedulable.manualBias !== undefined);

  return {
    occurrenceId: `${SEQUENCE_ID_PREFIX}${sequenceId}`,
    taskId: `${SEQUENCE_ID_PREFIX}${sequenceId}`,
    calendarId: first.calendarId,
    categoryId: first.categoryId,
    durationMin,
    cooldownMin,
    sequenceId,
    ...(due ?? {}),
    ...(startFloor === undefined ? {} : { manualFloor: startFloor }),
    ...(priority === undefined ? {} : { priority }),
    ...(focusLevel === undefined ? {} : { focusLevel }),
    ...(preferred?.schedulable.preferredRange === undefined
      ? {}
      : { preferredRange: preferred.schedulable.preferredRange }),
    ...(biased?.schedulable.manualBias === undefined
      ? {}
      : { manualBias: biased.schedulable.manualBias - biased.startOffset }),
  };
}

function maxDefined<T>(
  items: readonly T[],
  key: (item: T) => number | undefined,
): number | undefined {
  let best: number | undefined;
  for (const item of items) {
    const value = key(item);
    if (value === undefined) continue;
    best = best === undefined ? value : Math.max(best, value);
  }
  return best;
}

/** Expands a placed block back into one placement per member. */
export function expandUnit(unit: PlacementUnit, blockStart: Instant): Placement[] {
  return unit.members.map(({ schedulable, startOffset }) => ({
    occurrenceId: schedulable.occurrenceId,
    interval: {
      start: blockStart + startOffset,
      end: blockStart + startOffset + schedulable.durationMin,
    },
    cooldownMin: schedulable.cooldownMin,
  }));
}

/** True when the unit is a sequence rather than a lone task. */
export function isSequenceUnit(unit: PlacementUnit): boolean {
  return unit.sequenceId !== undefined;
}

/** How the unit should be named in a diagnostic addressed to a user. */
export function describeUnit(unit: PlacementUnit): string {
  return unit.sequenceId === undefined
    ? `Task ${unit.composite.taskId}`
    : `Sequence ${unit.sequenceId}`;
}
