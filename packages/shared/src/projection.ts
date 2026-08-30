import {
  deferFloor,
  localDay,
  toCivilDate,
  type DeferTarget,
  type Instant,
  type Interval,
  type ScheduleContext,
  type Schedulable,
  type TuningConfig,
} from '@ambitime/scheduler';
import type { CommandRequest } from './api.js';

/**
 * What a command would do to the solver's input (spec §3.3, §3.4).
 *
 * The client shows the effect of a gesture before the server has answered. To
 * do that honestly it has to run the *same* solve the server will run, over the
 * same facts — so the only thing it may compute for itself is the small change
 * the command makes to those facts. That change is here, once, and the server's
 * test proves it agrees with the real write path.
 *
 * **This is not a second write path.** Nothing here persists anything or is
 * consulted by the server when applying a command; the handlers remain the
 * authority, and their answer replaces whatever this produced. What it buys is
 * the difference between a UI that responds and a UI that waits.
 *
 * **Not every command is modelled, on purpose.** A command with no projection
 * returns `null`, and the client simply waits for the server rather than
 * guessing — which is the right answer for anything whose effect depends on
 * state the client does not hold. Guessing wrong is worse than not guessing:
 * the user would watch the schedule move twice.
 */

export interface ProjectionInput {
  context: ScheduleContext;
  command: CommandRequest;
  config: TuningConfig;
}

export function projectCommand({
  context,
  command,
  config,
}: ProjectionInput): ScheduleContext | null {
  switch (command.type) {
    case 'MoveTask':
      return floorTask(context, command.params.taskId, toInstant(command.params.datetime), true);

    case 'ClearFloor':
      return mapTask(context, command.params.taskId, (schedulable) => {
        const { manualFloor: _floor, manualBias: _bias, ...rest } = schedulable;
        return rest;
      });

    case 'DeferTask': {
      const floor = floorForDefer(command.params.target, context, config);
      return floor === null ? null : floorTask(context, command.params.taskId, floor, false);
    }

    case 'ExtendTask':
      return mapTask(context, command.params.taskId, (schedulable) => ({
        ...schedulable,
        durationMin: command.params.newEstimateMin,
      }));

    // Completed and cancelled work stops being demand, so it simply leaves the
    // context; the slot and its cooldown come back by re-derivation rather than
    // by anything moving them (§7.3).
    case 'CompleteTask':
    case 'CancelTask':
      return withSchedulables(
        context,
        context.schedulables.filter((s) => s.taskId !== command.params.taskId),
      );

    case 'PostponeRestOfDay': {
      const calendar = calendarOf(context, command.params.calendarId);
      if (calendar === undefined) return null;

      const day = localDay(toCivilDate(command.params.date), calendar.timeZone);
      // A day already over is a no-op, exactly as the handler treats it.
      if (day.end <= context.now) return context;

      return postpone(context, command.params.calendarId, day, day.end);
    }

    case 'AddUnavailability':
      return withFixedBlock(context, command.params.calendarId, {
        start: toInstant(command.params.start),
        end: toInstant(command.params.end),
      });

    case 'AddAppointment':
      return withFixedBlock(context, command.params.calendarId, {
        start: toInstant(command.params.start),
        end: toInstant(command.params.end),
      });

    /**
     * Everything else waits for the server.
     *
     * `SwapTasks` consults the validator over a proposed pair and falls back to
     * `SwapForward` when the exchange does not hold — a decision, not a
     * transform, and one the client would have to reimplement to predict.
     * `Undo` and `Redo` are decided by a log the client does not have. The
     * creates and edits need ids and inherited values that only exist once the
     * row does.
     */
    default:
      return null;
  }
}

/**
 * `MoveTask` sets a floor *and* a bias; `DeferTask` sets only a floor.
 *
 * The difference is the whole of §7.3: a reposition says "not before here, and
 * here if you can", while a deferral says only "not before here" and leaves the
 * solver free to choose. Collapsing the two would make every defer behave like
 * a drag.
 */
function floorTask(
  context: ScheduleContext,
  taskId: string,
  floor: Instant,
  withBias: boolean,
): ScheduleContext {
  return mapTask(context, taskId, (schedulable) => ({
    ...schedulable,
    manualFloor: floor,
    ...(withBias ? { manualBias: floor } : {}),
  }));
}

/**
 * The engine's own `deferFloor`, given the zone from the context.
 *
 * Called rather than reimplemented: two answers to "what does tomorrow mean"
 * would disagree the first time `firstDayOfWeek` changed, and the disagreement
 * would surface as the schedule jumping after a gesture that had looked settled.
 */
function floorForDefer(
  target: DeferTarget,
  context: ScheduleContext,
  config: TuningConfig,
): Instant | null {
  const calendar = context.calendars[0];
  return calendar === undefined ? null : deferFloor(target, context.now, calendar.timeZone, config);
}

/**
 * Pushes everything the day still holds past `floor` (spec §7.2).
 *
 * The client cannot see placements from here — the context is the *input* to a
 * solve, not its output — so "everything placed on this day" is approximated by
 * "everything that could be placed on this day": every schedulable of the
 * calendar whose floor does not already put it past the day.
 *
 * That over-reaches slightly. A task that was going to land next Thursday
 * anyway picks up a floor it did not need, which changes nothing about where it
 * goes. The server's version selects on the actual placements and is the
 * authority; this one only has to look right for the moment before its answer
 * arrives.
 */
function postpone(
  context: ScheduleContext,
  calendarId: string,
  day: Interval,
  floor: Instant,
): ScheduleContext {
  return withSchedulables(
    context,
    context.schedulables.map((schedulable) => {
      if (schedulable.calendarId !== calendarId) return schedulable;
      if (schedulable.manualFloor !== undefined && schedulable.manualFloor >= day.end) {
        return schedulable;
      }

      // The floor replaces whatever was there, which is §7.3's "floor clears on
      // a bulk reschedule": a task positioned by hand on this day is exactly
      // the one that must not stay, and its old floor would put it back.
      const { manualBias: _bias, ...rest } = schedulable;
      return { ...rest, manualFloor: floor };
    }),
  );
}

function mapTask(
  context: ScheduleContext,
  taskId: string,
  change: (schedulable: Schedulable) => Schedulable,
): ScheduleContext {
  return withSchedulables(
    context,
    context.schedulables.map((s) => (s.taskId === taskId ? change(s) : s)),
  );
}

function withSchedulables(context: ScheduleContext, schedulables: Schedulable[]): ScheduleContext {
  return { ...context, schedulables };
}

function withFixedBlock(
  context: ScheduleContext,
  calendarId: string,
  interval: Interval,
): ScheduleContext {
  return {
    ...context,
    fixedBlocks: [
      ...context.fixedBlocks,
      // A provisional id: the row does not exist yet, and nothing in the engine
      // reads a fixed block's id except to report it deterministically.
      { id: `provisional-${interval.start}-${interval.end}`, calendarId, interval },
    ],
  };
}

function calendarOf(context: ScheduleContext, calendarId: string) {
  return context.calendars.find((calendar) => calendar.id === calendarId);
}

const MS_PER_MINUTE = 60_000;

/** ISO-8601 → the engine's integer minutes. */
function toInstant(iso: string): Instant {
  return Math.floor(Date.parse(iso) / MS_PER_MINUTE);
}
