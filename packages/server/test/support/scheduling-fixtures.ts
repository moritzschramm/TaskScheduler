import { withSystemPrivileges } from '../../src/db/context.js';
import {
  appointments,
  availabilityWindows,
  calendars,
  categories,
  taskOccurrences,
  tasks,
} from '../../src/db/schema/index.js';
import type { Database } from '../../src/db/client.js';
import type { NewAppointment, NewTask } from '../../src/db/schema/index.js';

/** Postgres `tstzrange` literal, always half-open (spec §5.1). */
export function tstzrangeLiteral(startIso: string, endIso: string): string {
  return `["${startIso}","${endIso}")`;
}

export async function createCalendar(
  db: Database,
  tenantId: string,
  ownerId: string,
  name = 'Primary',
): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx
      .insert(calendars)
      .values({ tenantId, ownerId, name })
      .returning({ id: calendars.id });
    if (!row) throw new Error('Failed to create calendar');
    return row.id;
  });
}

export async function createCategory(
  db: Database,
  tenantId: string,
  name: string,
  defaultCooldownMin = 0,
): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx
      .insert(categories)
      .values({ tenantId, name, defaultCooldownMin })
      .returning({ id: categories.id });
    if (!row) throw new Error('Failed to create category');
    return row.id;
  });
}

export async function createAvailabilityWindow(
  db: Database,
  values: {
    tenantId: string;
    calendarId: string;
    categoryId: string;
    weekday: number;
    startMin: number;
    endMin: number;
    focusLevel?: number;
  },
): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx
      .insert(availabilityWindows)
      .values(values)
      .returning({ id: availabilityWindows.id });
    if (!row) throw new Error('Failed to create availability window');
    return row.id;
  });
}

export async function createTask(db: Database, values: NewTask): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx.insert(tasks).values(values).returning({ id: tasks.id });
    if (!row) throw new Error('Failed to create task');
    return row.id;
  });
}

export async function createOccurrence(
  db: Database,
  tenantId: string,
  taskId: string,
): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx
      .insert(taskOccurrences)
      .values({ tenantId, taskId })
      .returning({ id: taskOccurrences.id });
    if (!row) throw new Error('Failed to create occurrence');
    return row.id;
  });
}

export async function createAppointment(db: Database, values: NewAppointment): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [row] = await tx.insert(appointments).values(values).returning({ id: appointments.id });
    if (!row) throw new Error('Failed to create appointment');
    return row.id;
  });
}

/**
 * Builds a chain of nested tasks and returns their ids, root first. Used by the
 * depth-cap tests, where the interesting case is the one that must fail.
 */
export async function createTaskChain(
  db: Database,
  base: { tenantId: string; calendarId: string; ownerId: string },
  length: number,
): Promise<string[]> {
  const ids: string[] = [];
  let parentId: string | null = null;

  for (let i = 0; i < length; i += 1) {
    const id: string = await createTask(db, {
      ...base,
      title: `Level ${i + 1}`,
      ...(parentId ? { parentId } : {}),
    });
    ids.push(id);
    parentId = id;
  }

  return ids;
}
