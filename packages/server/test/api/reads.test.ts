import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  backlogResponseSchema,
  calendarListSchema,
  capacityResponseSchema,
  notificationListSchema,
  scheduleResponseSchema,
} from '@ambitime/shared';
import { tasks } from '../../src/db/schema/index.js';
import { withSystemPrivileges } from '../../src/db/context.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The read side (spec §3.4, §6.1, §6.6, §11).
 *
 * Every one of these re-derives rather than serving the cache, and the tests
 * are written to notice if that ever changes: what a read returns has to agree
 * with what the last command returned, and has to keep agreeing as `now` moves.
 */
describe('the read endpoints', () => {
  let handle: DatabaseHandle;
  let world: ApiWorld;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createApiWorld(handle.db);
  });

  const createTask = (title: string, extra: Record<string, unknown> = {}) =>
    world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        ...extra,
      },
    } as never);

  const taskIdOf = async (title: string) => {
    const rows = await withSystemPrivileges(handle.db, (tx) =>
      tx.select({ id: tasks.id, title: tasks.title }).from(tasks),
    );
    return rows.find((row) => row.title === title)!.id;
  };

  it('lists the calendars of the active tenant', async () => {
    const body = calendarListSchema.parse(await (await world.get('/api/calendars')).json());

    expect(body.calendars).toEqual([
      { id: world.calendarId, name: 'Primary', timezone: 'Europe/Berlin' },
    ]);
  });

  it('returns a schedule that agrees with what the command returned', async () => {
    const written = await createTask('Write the report');

    const body = scheduleResponseSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/schedule`)).json(),
    );

    // The same answer, because both derived it from the same source at the
    // same `now` — not because one of them cached it for the other.
    expect(body.schedule.blocks).toEqual(written.schedules[0]?.blocks);
    expect(body.schedule.horizon).toEqual(written.schedules[0]?.horizon);
  });

  it('includes the fixed blocks a grid has to draw around', async () => {
    await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Standup',
        start: '2026-03-23T08:00:00Z',
        end: '2026-03-23T08:30:00Z',
      },
    });
    await world.run({
      type: 'AddUnavailability',
      params: {
        calendarId: world.calendarId,
        start: '2026-03-23T13:00:00Z',
        end: '2026-03-23T15:00:00Z',
      },
    });

    const body = scheduleResponseSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/schedule`)).json(),
    );

    expect(body.fixedBlocks).toHaveLength(2);
    expect(body.fixedBlocks.map((block) => block.isUnavailability)).toEqual([false, true]);
    // The content-free one carries no invented title (§7.4).
    expect(body.fixedBlocks[1]?.title).toBe('');
  });

  it('reports the backlog with the week the coarse planner chose', async () => {
    await createTask('Later');
    await world.run({ type: 'MoveToBacklog', params: { taskId: await taskIdOf('Later') } });

    const body = backlogResponseSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/backlog`)).json(),
    );

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ title: 'Later' });
    expect(body.entries[0]?.estimatedWeek).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reports capacity as a plain ratio, per category and week', async () => {
    await createTask('One');
    await createTask('Two');

    const body = capacityResponseSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/capacity`)).json(),
    );

    expect(body.cells.length).toBeGreaterThan(0);
    const [cell] = body.cells;
    expect(cell?.categoryId).toBe(world.categoryId);
    // Fixed point is the engine's business (§6.3); an API that shipped
    // 1_250_000 would be asking every consumer to know the same secret.
    expect(cell?.utilization).toBeLessThan(1);
    expect(cell?.status).toBe('comfortable');
  });

  it('returns an empty notification list rather than an error', async () => {
    const body = notificationListSchema.parse(await (await world.get('/api/notifications')).json());

    // M13 produces them and M15 delivers them; the seam answers now so neither
    // changes the client's data flow when it lands.
    expect(body.notifications).toEqual([]);
  });

  it('reports a calendar in another tenant as absent, not forbidden', async () => {
    // Under RLS "not yours" and "does not exist" are the same answer, and that
    // is the right one: distinguishing them tells a caller what exists.
    const other = await createApiWorld(handle.db);

    const response = await world.get(`/api/calendars/${other.calendarId}/schedule`);

    expect(response.status).toBe(404);
  });

  it('turns away every read without a session', async () => {
    for (const path of [
      '/api/calendars',
      `/api/calendars/${world.calendarId}/schedule`,
      `/api/calendars/${world.calendarId}/backlog`,
      `/api/calendars/${world.calendarId}/capacity`,
      '/api/notifications',
    ]) {
      expect((await world.app.app.request(path)).status).toBe(401);
    }
  });
});
