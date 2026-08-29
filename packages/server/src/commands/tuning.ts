/**
 * Tuning values belonging to the command layer.
 *
 * Spec §15's list is the scheduler's; these are the write path's own, kept here
 * for the same reason (operating-brief rule #7): a number that decides
 * behaviour should be findable, named and changed in one place rather than
 * discovered inline months later.
 */

/**
 * How far back `Undo` will look through one actor's history.
 *
 * Undo has to fold the log forward to know what is still undone, so the window
 * bounds the work a single keystroke can cost. Two hundred commands is far more
 * than a session's worth of actions and far less than a query anyone would
 * notice; past it, undo says so rather than reporting that there is nothing
 * left to undo, which would be a different and false statement.
 */
export const UNDO_HISTORY_DEPTH = 200;
