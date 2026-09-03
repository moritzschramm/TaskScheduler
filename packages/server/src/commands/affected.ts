import { eq, inArray } from 'drizzle-orm';
import { placements, taskOccurrences } from '../db/schema/index.js';
import type { RowChange } from './journal.js';
import type { Transaction } from '../db/client.js';

/**
 * How many tasks a command actually moved — the number the history shows.
 *
 * The log records row images, and a count of those answers "how many rows did
 * this write", which is a question about the database rather than about the
 * week. The two diverge in both directions, and the interesting direction is
 * this one: `AddUnavailability` writes exactly one row — an appointment — and
 * can push a dozen tasks into other days. Its footprint in the journal is 1.
 * What the user wants to know is 12.
 *
 * So a task counts as affected if the command wrote its row, **or** if its
 * placement is not where it was. The second half cannot come from the journal
 * at all: placements are derived (§3.3), deliberately never journalled, and
 * re-derived wholesale after every command. It has to be observed, by comparing
 * the cache either side of the write.
 *
 * **What this measures, exactly.** The comparison is against the cache the
 * previous command left, not against a fresh solve at this instant, so a
 * placement that would have moved anyway — because the horizon rolls with `now`
 * (§6.1) and hours have passed since — is counted here too. Pinning that down
 * would mean solving twice per command to produce a number nobody acts on. For
 * commands issued while somebody is looking at the screen, which is every
 * command whose count is ever read, the gap is nothing.
 */

/** A placed occurrence, reduced to what a comparison needs. */
interface PlacedTask {
  taskId: string;
  calendarId: string;
  /** The range literal. Postgres normalises it, so equal spans compare equal. */
  during: string;
}

export type PlacementSnapshot = ReadonlyMap<string, PlacedTask>;

/**
 * The placements currently cached, by occurrence.
 *
 * The "before" side is taken with no `calendarIds`, because it happens before
 * the handler runs and which calendars it will touch is not yet known — and
 * taking it afterwards would miss any placement that had already cascaded away
 * with a deleted occurrence. RLS scopes that read to the tenant.
 *
 * The "after" side names the calendars, because by then they are known and
 * only those were re-derived. A calendar the command did not touch cannot have
 * moved, so narrowing the second read cannot narrow the count — it only stops
 * the query walking a second calendar's fortnight to prove nothing changed in
 * it.
 */
export async function snapshotPlacements(
  tx: Transaction,
  calendarIds?: readonly string[],
): Promise<PlacementSnapshot> {
  if (calendarIds !== undefined && calendarIds.length === 0) return new Map();

  const rows = await tx
    .select({
      occurrenceId: placements.occurrenceId,
      taskId: taskOccurrences.taskId,
      calendarId: placements.calendarId,
      during: placements.during,
    })
    .from(placements)
    .innerJoin(taskOccurrences, eq(taskOccurrences.id, placements.occurrenceId))
    .where(
      calendarIds === undefined ? undefined : inArray(placements.calendarId, [...calendarIds]),
    );

  return new Map(
    rows.map((row) => [
      row.occurrenceId,
      { taskId: row.taskId, calendarId: row.calendarId, during: row.during },
    ]),
  );
}

/**
 * Distinct tasks the command wrote or moved.
 *
 * Occurrences are counted through their task: two occurrences of one repeating
 * task shifting is one task affected, because "3 tasks affected" reads as three
 * things in your week and a person does not experience their Tuesday and
 * Thursday gym slots as two separate concerns.
 */
export function countAffectedTasks(
  changes: readonly RowChange[],
  before: PlacementSnapshot,
  after: PlacementSnapshot,
  /** The calendars the command re-derived; nothing else can have moved. */
  derivedCalendarIds: readonly string[],
): number {
  const affected = new Set<string>();
  const derived = new Set(derivedCalendarIds);

  for (const change of changes) {
    if (change.table === 'tasks') affected.add(change.id);
  }

  // Moved or unplaced. The task id comes from the side that has the row.
  //
  // Restricted to what the "after" side covers: it names the calendars that
  // were re-derived, so a placement absent from it because its calendar was
  // never looked at has not moved — only one that its own calendar re-derived
  // without has.
  for (const [occurrenceId, placed] of before) {
    if (!derived.has(placed.calendarId)) continue;
    const now = after.get(occurrenceId);
    if (now === undefined || now.during !== placed.during) affected.add(placed.taskId);
  }

  // Newly placed — something that had no slot before this command and has one now.
  for (const [occurrenceId, placed] of after) {
    if (!before.has(occurrenceId)) affected.add(placed.taskId);
  }

  return affected.size;
}
