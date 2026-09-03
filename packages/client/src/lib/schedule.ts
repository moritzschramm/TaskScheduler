import {
  notificationListSchema,
  calendarListSchema,
  scheduleResponseSchema,
  taskListSchema,
  type CalendarSummary,
  type CapacityCell,
  type CompletedBlock,
  type FixedBlock,
  type Notification,
  type Schedule,
  type TaskNode,
} from '@ambitime/shared';
import { api, expectOk } from './api';

/**
 * Reads, parsed with the shared schemas (spec §3.1).
 *
 * Every response goes through the same Zod schema the server validated it
 * against on the way out. That is not belt and braces: the two sides are
 * deployed separately, so a client running against an older or newer server is
 * a real state, and the difference between "the contract moved" and "the grid
 * rendered nonsense" is this parse.
 */

export interface ScheduleView {
  schedule: Schedule;
  fixedBlocks: FixedBlock[];
  /** What was done, still drawn where it was done (§3.4, §7.3). */
  completedBlocks: CompletedBlock[];
  /** Utilization from the same solve, so the two cannot disagree (§6.6). */
  capacity: CapacityCell[];
}

export async function fetchCalendars(): Promise<CalendarSummary[]> {
  const response = await api.api.calendars.$get();
  return calendarListSchema.parse(await expectOk(response)).calendars;
}

export async function fetchSchedule(calendarId: string): Promise<ScheduleView> {
  const response = await api.api.calendars[':calendarId'].schedule.$get({
    param: { calendarId },
    query: {},
  });

  return scheduleResponseSchema.parse(await expectOk(response));
}

export async function fetchTasks(calendarId: string): Promise<TaskNode[]> {
  const response = await api.api.calendars[':calendarId'].tasks.$get({ param: { calendarId } });
  return taskListSchema.parse(await expectOk(response)).tasks;
}

/**
 * No `fetchBacklog` or `fetchCapacity`.
 *
 * Both endpoints still exist for a caller that wants one of those answers on
 * its own — but every screen here wants them *beside* the schedule, and each
 * costs a full solve of the same calendar to produce something
 * `fetchSchedule` already returned. Reaching for them from a view is almost
 * always a way of paying three times for one answer.
 */

/** The engine's signals for the signed-in user (spec §11). */
export async function fetchNotifications(): Promise<Notification[]> {
  const response = await api.api.notifications.$get();
  return notificationListSchema.parse(await expectOk(response)).notifications;
}
