import {
  backlogResponseSchema,
  notificationListSchema,
  calendarListSchema,
  capacityResponseSchema,
  scheduleResponseSchema,
  taskListSchema,
  type BacklogEntry,
  type CalendarSummary,
  type CapacityCell,
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

export async function fetchBacklog(calendarId: string): Promise<BacklogEntry[]> {
  const response = await api.api.calendars[':calendarId'].backlog.$get({ param: { calendarId } });
  return backlogResponseSchema.parse(await expectOk(response)).entries;
}

export async function fetchTasks(calendarId: string): Promise<TaskNode[]> {
  const response = await api.api.calendars[':calendarId'].tasks.$get({ param: { calendarId } });
  return taskListSchema.parse(await expectOk(response)).tasks;
}

export async function fetchCapacity(calendarId: string): Promise<CapacityCell[]> {
  const response = await api.api.calendars[':calendarId'].capacity.$get({ param: { calendarId } });
  return capacityResponseSchema.parse(await expectOk(response)).cells;
}

/** The engine's signals for the signed-in user (spec §11). */
export async function fetchNotifications(): Promise<Notification[]> {
  const response = await api.api.notifications.$get();
  return notificationListSchema.parse(await expectOk(response)).notifications;
}
