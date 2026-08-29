import type { Command, CommandType } from '@ambitime/shared';
import type { CommandContext, HandlerOutcome } from './context.js';
import { addAppointment, addUnavailability, editAppointment } from './handlers/appointments.js';
import { clearWeek, postponeRestOfDay } from './handlers/bulk.js';
import { completeTask, deferTask, moveTask } from './handlers/manual.js';
import { createTask, editTask } from './handlers/tasks.js';
import { cancelTask, extendTask, moveToBacklog, promoteFromBacklog } from './handlers/lifecycle.js';
import { swapForward, swapTasks } from './handlers/swap.js';
import { redo, undo } from './handlers/history.js';

/**
 * The command vocabulary, bound to the code that carries each one out.
 *
 * A `switch` rather than a lookup table, so the compiler is the thing that
 * notices when a command is added to the shared schema and forgotten here — a
 * map keyed by `CommandType` would be satisfied by a cast, and a missing entry
 * would surface as a runtime `undefined is not a function` at the exact moment
 * a user tried the new action.
 */
export function dispatch(command: Command, ctx: CommandContext): Promise<HandlerOutcome> {
  switch (command.type) {
    case 'CreateTask':
      return createTask(command.params, ctx);
    case 'EditTask':
      return editTask(command.params, ctx);
    case 'AddAppointment':
      return addAppointment(command.params, ctx);
    case 'EditAppointment':
      return editAppointment(command.params, ctx);
    case 'MoveTask':
      return moveTask(command.params, ctx);
    case 'DeferTask':
      return deferTask(command.params, ctx);
    case 'CompleteTask':
      return completeTask(command.params, ctx);
    case 'PostponeRestOfDay':
      return postponeRestOfDay(command.params, ctx);
    case 'ClearWeek':
      return clearWeek(command.params, ctx);
    case 'ExtendTask':
      return extendTask(command.params, ctx);
    case 'CancelTask':
      return cancelTask(command.params, ctx);
    case 'SwapTasks':
      return swapTasks(command.params, ctx);
    case 'SwapForward':
      return swapForward(command.params, ctx);
    case 'PromoteFromBacklog':
      return promoteFromBacklog(command.params, ctx);
    case 'MoveToBacklog':
      return moveToBacklog(command.params, ctx);
    case 'AddUnavailability':
      return addUnavailability(command.params, ctx);
    case 'Undo':
      return undo(command.params, ctx);
    case 'Redo':
      return redo(command.params, ctx);
  }
}

/**
 * The entity each command's `expected_version` refers to (spec §7.1, §5.4).
 *
 * `null` marks a command that names no single versioned target: a create has
 * nothing to lock yet, and a bulk reflow's target is a day, which is not a row.
 * Those reject a supplied version rather than ignoring it — an ignored
 * optimistic lock is worse than none, because the caller believes it is
 * protected.
 */
export const COMMAND_TARGETS: Readonly<Record<CommandType, 'task' | 'appointment' | null>> = {
  CreateTask: null,
  EditTask: 'task',
  AddAppointment: null,
  EditAppointment: 'appointment',
  MoveTask: 'task',
  DeferTask: 'task',
  CompleteTask: 'task',
  PostponeRestOfDay: null,
  ClearWeek: null,
  ExtendTask: 'task',
  CancelTask: 'task',
  // A swap names two tasks, so one version could only ever guard one of them —
  // and a lock that covers half of what a command touches is worse than none.
  SwapTasks: null,
  SwapForward: 'task',
  PromoteFromBacklog: 'task',
  MoveToBacklog: 'task',
  AddUnavailability: null,
  // Undo names no entity at all: what it reverses is decided by the log, and a
  // version supplied against "whatever I did last" guards nothing.
  Undo: null,
  Redo: null,
};
