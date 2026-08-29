import { desc, eq } from 'drizzle-orm';
import { commands } from '../db/schema/index.js';
import { UNDO_HISTORY_DEPTH } from './tuning.js';
import type { CommandContext } from './context.js';
import type { CommandJournal } from './journal.js';

/**
 * The undo/redo stacks, read out of the command log (spec §7.5, §12).
 *
 * There is no "undone" flag anywhere, and there could not be: the log has
 * UPDATE and DELETE revoked from the application role, so nothing in it can be
 * amended after the fact. What there is instead is `Undo` and `Redo` appended
 * as commands in their own right, and the stacks are reconstructed by replaying
 * the log's own history of intentions.
 *
 * That is a stronger arrangement than a flag, not merely a stricter one. The
 * log stays a record of what a person did, in order, including changing their
 * mind — and undo cannot disagree with history, because it *is* history, folded.
 */

/** One command as history sees it: what it was, and what it did. */
export interface HistoryEntry {
  id: string;
  seq: bigint;
  type: string;
  groupId: string | null;
  journal: CommandJournal;
}

/**
 * What one press of undo reverses: a command, or a whole group of them (§7.5).
 *
 * Entries are held in ascending `seq`, so undo walks them backwards and redo
 * forwards without either having to sort again.
 */
export interface HistoryUnit {
  groupId: string | null;
  entries: HistoryEntry[];
}

export interface History {
  /** Applied and reversible; the last element is what `Undo` takes. */
  undoable: HistoryUnit[];
  /** Reversed and replayable; the last element is what `Redo` takes. */
  redoable: HistoryUnit[];
  /**
   * The window filled up, so an empty `undoable` means "no further back than
   * this" rather than "nothing was ever done".
   */
  truncated: boolean;
}

const EMPTY_JOURNAL: CommandJournal = { calendarIds: [], changes: [] };

/**
 * Folds one actor's log into the two stacks.
 *
 * Per **actor**, not per tenant. The log belongs to the tenant and history and
 * audit (§12) read it that way, but undo is a personal gesture: in a shared
 * calendar, reaching back into a colleague's work because they happened to act
 * more recently than you is not what anyone means by pressing it. §7.5 does not
 * say, and this is the reading that cannot surprise someone badly.
 */
export async function readHistory(ctx: CommandContext): Promise<History> {
  const rows = await ctx.tx
    .select({
      id: commands.id,
      seq: commands.seq,
      type: commands.type,
      groupId: commands.groupId,
      inverse: commands.inverse,
    })
    .from(commands)
    .where(eq(commands.actorId, ctx.actorId))
    .orderBy(desc(commands.seq))
    .limit(UNDO_HISTORY_DEPTH);

  const ascending = [...rows].reverse();
  const undoable: HistoryUnit[] = [];
  const redoable: HistoryUnit[] = [];

  for (const row of ascending) {
    if (row.type === 'Undo') {
      const unit = undoable.pop();
      if (unit) redoable.push(unit);
      continue;
    }

    if (row.type === 'Redo') {
      const unit = redoable.pop();
      if (unit) undoable.push(unit);
      continue;
    }

    const entry: HistoryEntry = {
      id: row.id,
      seq: row.seq,
      type: row.type,
      groupId: row.groupId,
      journal: (row.inverse as CommandJournal | null) ?? EMPTY_JOURNAL,
    };

    // Doing something new is what discards the redo stack — the branch of
    // history those commands belonged to is no longer the one being lived.
    redoable.length = 0;

    const open = undoable[undoable.length - 1];
    if (entry.groupId !== null && open?.groupId === entry.groupId) {
      open.entries.push(entry);
    } else {
      undoable.push({ groupId: entry.groupId, entries: [entry] });
    }
  }

  return { undoable, redoable, truncated: rows.length === UNDO_HISTORY_DEPTH };
}

/** Every calendar a unit's commands touched, deduplicated. */
export function calendarsOf(unit: HistoryUnit): string[] {
  return [...new Set(unit.entries.flatMap((entry) => entry.journal.calendarIds))];
}
