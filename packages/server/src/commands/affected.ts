import { eq } from 'drizzle-orm';
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
  /** The range literal. Postgres normalises it, so equal spans compare equal. */
  during: string;
}

export type PlacementSnapshot = ReadonlyMap<string, PlacedTask>;

/**
 * Every placement the tenant currently has cached, by occurrence.
 *
 * Tenant-wide rather than per-calendar because the "before" side is taken
 * before the handler runs, when which calendars it will touch is not yet known
 * — and taking it afterwards would miss any placement that had already
 * cascaded away with a deleted occurrence. RLS scopes the read to the tenant
 * and the cache is bounded by the horizon, so the wider net costs nothing.
 *
 * Calendars the command does not re-derive cannot change, so widening the
 * snapshot cannot widen the count.
 */
export async function snapshotPlacements(tx: Transaction): Promise<PlacementSnapshot> {
  const rows = await tx
    .select({
      occurrenceId: placements.occurrenceId,
      taskId: taskOccurrences.taskId,
      during: placements.during,
    })
    .from(placements)
    .innerJoin(taskOccurrences, eq(taskOccurrences.id, placements.occurrenceId));

  return new Map(rows.map((row) => [row.occurrenceId, { taskId: row.taskId, during: row.during }]));
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
): number {
  const affected = new Set<string>();

  for (const change of changes) {
    if (change.table === 'tasks') affected.add(change.id);
  }

  // Moved or unplaced. The task id comes from the side that has the row.
  for (const [occurrenceId, placed] of before) {
    const now = after.get(occurrenceId);
    if (now === undefined || now.during !== placed.during) affected.add(placed.taskId);
  }

  // Newly placed — something that had no slot before this command and has one now.
  for (const [occurrenceId, placed] of after) {
    if (!before.has(occurrenceId)) affected.add(placed.taskId);
  }

  return affected.size;
}
