import { calendarsOf, readHistory, type HistoryUnit } from '../history.js';
import { applyChanges } from '../journal.js';
import { PreconditionFailedError } from '../errors.js';
import type { CommandContext, HandlerOutcome } from '../context.js';
import type { RedoParams, UndoParams } from '@ambitime/shared';

/**
 * `Undo()` and `Redo()` — spec §7.5.
 *
 * "Reverse / replay the last command (or command group, for bulk actions,
 * atomically), then re-derive. Backed by the command log (§12)."
 *
 * Atomicity needs no special handling and gets none: a command's whole change
 * set is applied inside the one transaction `applyCommand` opened, so a group
 * reverses completely or not at all for the same reason every other command
 * does. §7.2's bulk actions are single commands touching many rows, which makes
 * them atomic by construction — the group machinery is for a caller that ties
 * several commands together deliberately.
 *
 * Re-derivation is not asked for here either. Undo restores *source* rows, and
 * `applyCommand` re-derives every calendar a handler names, so the schedule
 * that comes back is recomputed from the restored source like any other — never
 * a cached one rolled back alongside it.
 */

export async function undo(_params: UndoParams, ctx: CommandContext): Promise<HandlerOutcome> {
  const history = await readHistory(ctx);
  const unit = history.undoable[history.undoable.length - 1];

  if (!unit) {
    throw new PreconditionFailedError(
      history.truncated
        ? `There is nothing left to undo within the last ${history.undoable.length} commands of history`
        : 'There is nothing to undo',
    );
  }

  // Backwards through the group as well as through each command's changes: a
  // later command may have built on an earlier one's rows.
  for (const entry of [...unit.entries].reverse()) {
    await applyChanges(ctx, entry.journal.changes, 'undo');
  }

  return outcomeFor(unit);
}

export async function redo(_params: RedoParams, ctx: CommandContext): Promise<HandlerOutcome> {
  const history = await readHistory(ctx);
  const unit = history.redoable[history.redoable.length - 1];

  if (!unit) throw new PreconditionFailedError('There is nothing to redo');

  for (const entry of unit.entries) {
    await applyChanges(ctx, entry.journal.changes, 'redo');
  }

  return outcomeFor(unit);
}

/**
 * The calendars to re-derive, and the commands this one named.
 *
 * Naming the targets is what the log's own design asks for: undo is itself a
 * command naming what it reversed, which keeps the history readable as a
 * sequence of intentions rather than as a set of mysterious state changes.
 */
function outcomeFor(unit: HistoryUnit): HandlerOutcome {
  return {
    calendarIds: calendarsOf(unit),
    targets: unit.entries.map((entry) => entry.id),
  };
}
