import type { Command, CommandType } from '@ambitime/shared';
import type { CommandContext, HandlerOutcome } from './context.js';
import { addAppointment, addUnavailability, editAppointment } from './handlers/appointments.js';
import { blockOutDay, clearWeek, postponeRestOfDay } from './handlers/bulk.js';
import { clearFloor, completeTask, deferTask, moveTask } from './handlers/manual.js';
import { createTask, editTask } from './handlers/tasks.js';
import { cancelTask, extendTask, moveToBacklog, promoteFromBacklog } from './handlers/lifecycle.js';
import { swapForward, swapTasks } from './handlers/swap.js';
import { redo, undo } from './handlers/history.js';
import { markNotificationsRead } from './handlers/notifications.js';
import { updateSettings } from './handlers/settings.js';
import {
  configureCalendar,
  createCalendar,
  createActivityType,
  createWeekTypeOverride,
  deleteActivityType,
  deleteWeekTypeOverride,
  editActivityType,
  editWeekTypeOverride,
  setAvailabilityWindows,
  setCalendarWindows,
} from './handlers/configuration.js';

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
    case 'ClearFloor':
      return clearFloor(command.params, ctx);
    case 'DeferTask':
      return deferTask(command.params, ctx);
    case 'CompleteTask':
      return completeTask(command.params, ctx);
    case 'PostponeRestOfDay':
      return postponeRestOfDay(command.params, ctx);
    case 'BlockOutDay':
      return blockOutDay(command.params, ctx);
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
    case 'MarkNotificationsRead':
      return markNotificationsRead(command.params, ctx);
    case 'UpdateSettings':
      return updateSettings(command.params, ctx);
    case 'CreateCalendar':
      return createCalendar(command.params, ctx);
    case 'ConfigureCalendar':
      return configureCalendar(command.params, ctx);
    case 'SetCalendarWindows':
      return setCalendarWindows(command.params, ctx);
    case 'CreateActivityType':
      return createActivityType(command.params, ctx);
    case 'EditActivityType':
      return editActivityType(command.params, ctx);
    case 'DeleteActivityType':
      return deleteActivityType(command.params, ctx);
    case 'SetAvailabilityWindows':
      return setAvailabilityWindows(command.params, ctx);
    case 'CreateWeekTypeOverride':
      return createWeekTypeOverride(command.params, ctx);
    case 'EditWeekTypeOverride':
      return editWeekTypeOverride(command.params, ctx);
    case 'DeleteWeekTypeOverride':
      return deleteWeekTypeOverride(command.params, ctx);
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
export const COMMAND_TARGETS: Readonly<
  Record<
    CommandType,
    'task' | 'appointment' | 'calendar' | 'activity type' | 'week type override' | null
  >
> = {
  CreateTask: null,
  EditTask: 'task',
  AddAppointment: null,
  EditAppointment: 'appointment',
  MoveTask: 'task',
  ClearFloor: 'task',
  DeferTask: 'task',
  CompleteTask: 'task',
  PostponeRestOfDay: null,
  // Names a day, not a row.
  BlockOutDay: null,
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
  // Names a list, not one row, so there is no single version to lock.
  MarkNotificationsRead: null,
  // Names the actor, who is never in doubt; there is nothing to lock against.
  UpdateSettings: null,
  CreateCalendar: null,
  ConfigureCalendar: 'calendar',
  // The set is the unit, and a set has no version of its own — the calendar it
  // belongs to does, and that is what a stale editor would be holding.
  SetCalendarWindows: 'calendar',
  CreateActivityType: null,
  EditActivityType: 'activity type',
  DeleteActivityType: 'activity type',
  // Addressed by calendar *and* activity type; the calendar is the versioned half.
  SetAvailabilityWindows: 'calendar',
  CreateWeekTypeOverride: 'calendar',
  EditWeekTypeOverride: 'week type override',
  DeleteWeekTypeOverride: 'week type override',
  // Undo names no entity at all: what it reverses is decided by the log, and a
  // version supplied against "whatever I did last" guards nothing.
  Undo: null,
  Redo: null,
};
