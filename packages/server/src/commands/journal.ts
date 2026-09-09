import { eq, inArray, type SQL } from 'drizzle-orm';
import {
  appointments,
  availabilityWindows,
  calendars,
  calendarWindows,
  categories,
  notifications,
  taskOccurrences,
  tasks,
  users,
  weekTypeOverrides,
} from '../db/schema/index.js';
import type { CommandContext } from './context.js';
import type {
  NewAppointment,
  NewAvailabilityWindow,
  NewCalendar,
  NewCalendarWindow,
  NewCategory,
  NewNotification,
  NewTask,
  NewTaskOccurrence,
  NewUser,
  NewWeekTypeOverride,
} from '../db/schema/index.js';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * The reversible-change log (spec §12).
 *
 * §12 is explicit that this is **not** event sourcing: "mutable entity tables
 * plus a reversible-change log are sufficient and lighter. Each command records
 * enough to reverse it." So a command's entry in the log carries the before and
 * after image of every source row it touched, and undo is one mechanism —
 * put the rows back — rather than a bespoke inverse per command type.
 *
 * That distinction is the whole reason this module exists. An inverse expressed
 * as *another command* would need a command for every reversal that has no
 * natural opposite: un-creating a task, restoring forty floors a sick day
 * replaced, reinstating an occurrence that was retired when its parent grew a
 * child. Row images have none of those special cases, and they cannot drift
 * from what the handler actually did, because they *are* what it did.
 *
 * **Only source tables are journalled.** `placements` and `estimated_week` are
 * derived (§3.3): they are recomputed from source after every command, undo
 * included, so recording them would be recording an answer rather than a fact.
 * Nothing here can reach them — `deriveCalendarSchedule` writes them directly.
 *
 * `users` is in for the same narrow reason as `notifications`: §13's display
 * settings are a person's own decision, and changing one is exactly the kind of
 * thing somebody wants back. Nothing else about a user is written here.
 *
 * `notifications` is in the set for one column's sake. The rows themselves are
 * derived — `produceSignals` replaces them wholesale, outside the journal, for
 * the same reason placements are — but `read_at` is a person's decision about
 * one, and dismissing something is exactly the kind of act somebody wants back.
 */

/**
 * The tables a command may change, and the insert type each one takes.
 *
 * A closed set on purpose: anything reachable from a handler is reversible, and
 * adding a table here is the deliberate act of saying a new kind of state is
 * part of history. Configuration joined it in M11 for exactly that reason — a
 * mis-set availability window is precisely the kind of change a person wants
 * back, and the schedule it silently reflowed comes back with it.
 */
interface JournalInserts {
  tasks: NewTask;
  task_occurrences: NewTaskOccurrence;
  appointments: NewAppointment;
  calendars: NewCalendar;
  calendar_windows: NewCalendarWindow;
  categories: NewCategory;
  availability_windows: NewAvailabilityWindow;
  week_type_overrides: NewWeekTypeOverride;
  notifications: NewNotification;
  users: NewUser;
}

/**
 * `satisfies` rather than an annotation: it holds the map and the insert types
 * above to the same key set — a table added to one and not the other is a
 * compile error — while `keyof typeof` below still reads the literal keys.
 */
const JOURNALLED = {
  tasks,
  task_occurrences: taskOccurrences,
  appointments,
  calendars,
  calendar_windows: calendarWindows,
  categories,
  availability_windows: availabilityWindows,
  week_type_overrides: weekTypeOverrides,
  notifications,
  users,
} satisfies Record<keyof JournalInserts, PgTable>;

export type JournalTable = keyof typeof JOURNALLED;

/** A row's column values, keyed by Drizzle field name. */
export type RowImage = Record<string, unknown>;

/**
 * One row, before and after.
 *
 * `before: null` is a row the command created; `after: null` is one it removed.
 * For an update, both hold *only the columns the command set* — restoring the
 * whole row would silently revert a column somebody else changed in between,
 * which is a different and much larger promise than undo makes.
 */
export interface RowChange {
  table: JournalTable;
  id: string;
  before: RowImage | null;
  after: RowImage | null;
}

/**
 * What lands in `commands.inverse`.
 *
 * The calendars travel with the changes because undo has to re-derive, and
 * working out which calendars a set of row images belongs to after the fact is
 * strictly harder than remembering.
 */
export interface CommandJournal {
  calendarIds: string[];
  changes: RowChange[];
  /** For `Undo` / `Redo`: the commands this entry reversed or replayed (§7.5). */
  targets?: string[];
  /**
   * How many tasks the command wrote or moved — what the history reports.
   *
   * Not needed to reverse anything, and it lives here only because `inverse` is
   * `jsonb` and this is the one place per command that survives. It is written
   * by the apply pipeline, which is the only layer that can see a placement
   * either side of the change; see `affected.ts`. Absent on entries recorded
   * before it existed, which is why every reader treats it as unknown rather
   * than as zero.
   */
  affectedTasks?: number;
  /**
   * Set once `changes` has been dropped, past the undo window (`compact.ts`).
   *
   * A journal with no changes is otherwise ambiguous — `Undo` and `Redo` write
   * one, since their own writes are not journalled — and "this command wrote
   * nothing" and "what this command wrote is no longer kept" are different
   * enough facts that anyone reading the log deserves to be told which.
   */
  stripped?: true;
}

/** Per-table insert types, so call sites keep their column-name checking. */
type JournalValues<T extends JournalTable> = Partial<JournalInserts[T]>;

/**
 * Managed by the `touch_row()` trigger (§5.4), so never restored.
 *
 * An undo is a new change, not a rewind: the row's version must move *forward*,
 * or a client holding version 5 would find its stale lock accepted again.
 */
const TRIGGER_MANAGED: ReadonlySet<string> = new Set(['version', 'updatedAt']);

/**
 * Drizzle's query builders are typed per table and this module is deliberately
 * not — treating every table identically is its entire job. The casts are
 * confined to the four functions below; every call site above them passes a
 * `Partial<NewTask>` and friends, so column names are still checked where they
 * are written.
 */
function table(name: JournalTable): PgTable {
  return JOURNALLED[name];
}

function idColumn(name: JournalTable) {
  return JOURNALLED[name].id;
}

export async function insertRow<T extends JournalTable>(
  ctx: CommandContext,
  name: T,
  values: JournalValues<T>,
): Promise<string> {
  const [row] = await ctx.tx
    .insert(table(name))
    .values(values as never)
    .returning();

  if (!row) throw new Error(`Inserting a row into ${name} returned nothing`);

  const id = String((row as RowImage)['id']);
  ctx.journal.push({ table: name, id, before: null, after: image(row as RowImage) });
  return id;
}

/** Updates one row by id. Returns false when there was no such row. */
export async function updateRow<T extends JournalTable>(
  ctx: CommandContext,
  name: T,
  id: string,
  values: JournalValues<T>,
): Promise<boolean> {
  const updated = await updateWhere(ctx, name, eq(idColumn(name), id), values);
  return updated.length > 0;
}

/**
 * Updates every row matching `where`, recording each one's prior values.
 *
 * The before-image read takes `FOR UPDATE`, which is not only about the images:
 * a bulk reflow that read and wrote without locking could interleave with a
 * single-task command and journal a "before" that was never the row's state.
 */
export async function updateWhere<T extends JournalTable>(
  ctx: CommandContext,
  name: T,
  where: SQL,
  values: JournalValues<T>,
): Promise<string[]> {
  const columns = Object.keys(values);
  if (columns.length === 0) return [];

  const before = await ctx.tx.select().from(table(name)).where(where).for('update');
  if (before.length === 0) return [];

  await ctx.tx
    .update(table(name))
    .set(values as never)
    .where(where);

  const ids: string[] = [];
  for (const row of before as RowImage[]) {
    const id = String(row['id']);
    ids.push(id);
    ctx.journal.push({
      table: name,
      id,
      before: pick(row, columns),
      after: { ...(values as RowImage) },
    });
  }

  return ids;
}

/** Deletes every row matching `where`, recording each one whole. */
export async function deleteWhere<T extends JournalTable>(
  ctx: CommandContext,
  name: T,
  where: SQL,
): Promise<string[]> {
  const before = await ctx.tx.select().from(table(name)).where(where);
  if (before.length === 0) return [];

  await ctx.tx.delete(table(name)).where(where);

  const ids: string[] = [];
  for (const row of before as RowImage[]) {
    const id = String(row['id']);
    ids.push(id);
    ctx.journal.push({ table: name, id, before: image(row), after: null });
  }

  return ids;
}

/**
 * Puts a command's changes back, or puts them back in.
 *
 * `undo` walks the changes in reverse and restores each row's `before`; `redo`
 * walks them forward and restores each `after`. Reverse order is what makes
 * foreign keys work out: a command that created a task and then its occurrence
 * has its occurrence removed first, and one that removed them has the task
 * restored first.
 *
 * These writes are **not** journalled. An undo's effect is exactly its target's
 * change set read backwards, and recording it again would put a second copy of
 * every row image in the log for no gain.
 */
export async function applyChanges(
  ctx: CommandContext,
  changes: readonly RowChange[],
  direction: 'undo' | 'redo',
): Promise<void> {
  const ordered = direction === 'undo' ? [...changes].reverse() : changes;

  for (const change of ordered) {
    const target = direction === 'undo' ? change.before : change.after;
    const other = direction === 'undo' ? change.after : change.before;

    if (target === null) {
      await ctx.tx.delete(table(change.table)).where(eq(idColumn(change.table), change.id));
      continue;
    }

    // The row does not exist on this side of the change, so putting it back
    // means creating it — id included, since everything referring to it, the
    // rest of this change set included, names it by that id.
    if (other === null) {
      await ctx.tx.insert(table(change.table)).values({ ...target, id: change.id } as never);
      continue;
    }

    await ctx.tx
      .update(table(change.table))
      .set(target as never)
      .where(eq(idColumn(change.table), change.id));
  }
}

/** Rows a set of changes touched, by table — used to re-read what undo wrote. */
export function changedIds(changes: readonly RowChange[], name: JournalTable): string[] {
  return [...new Set(changes.filter((change) => change.table === name).map((change) => change.id))];
}

/** Convenience for the callers that need a `where` over those ids. */
export function whereIds(name: JournalTable, ids: readonly string[]): SQL {
  return inArray(idColumn(name), [...ids]);
}

function image(row: RowImage): RowImage {
  const copy: RowImage = {};
  for (const [key, value] of Object.entries(row)) {
    if (!TRIGGER_MANAGED.has(key)) copy[key] = value;
  }
  return copy;
}

function pick(row: RowImage, columns: readonly string[]): RowImage {
  const picked: RowImage = {};
  for (const column of columns) picked[column] = row[column] ?? null;
  return picked;
}
