import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  backlogResponseSchema,
  calendarConfigurationSchema,
  calendarListSchema,
  capacityResponseSchema,
  notificationListSchema,
  scheduleResponseSchema,
} from '@ambitime/shared';
import { eq } from 'drizzle-orm';
import { placements, tasks } from '../../src/db/schema/index.js';
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
        activityTypeId: world.activityTypeId,
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

  it('reports capacity as a plain ratio, per activity type and week', async () => {
    await createTask('One');
    await createTask('Two');

    const body = capacityResponseSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/capacity`)).json(),
    );

    expect(body.cells.length).toBeGreaterThan(0);
    const [cell] = body.cells;
    expect(cell?.activityTypeId).toBe(world.activityTypeId);
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

  /**
   * The configuration read (spec §4.3, §9.1) — the one read that does not
   * derive, because what it returns is the *input* to a solve.
   */
  it('returns the configuration a settings screen edits', async () => {
    await world.run({
      type: 'SetCalendarWindows',
      params: {
        calendarId: world.calendarId,
        kind: 'working',
        windows: [{ weekday: 1, startMin: 8 * 60, endMin: 18 * 60 }],
      },
    });
    await world.run({
      type: 'CreateWeekTypeOverride',
      params: {
        calendarId: world.calendarId,
        name: 'Conference',
        startDate: '2026-04-06',
        endDate: '2026-04-11',
      },
    });

    const response = await world.get(`/api/calendars/${world.calendarId}/configuration`);
    expect(response.status).toBe(200);

    const body = calendarConfigurationSchema.parse(await response.json());

    expect(body.calendar).toMatchObject({
      id: world.calendarId,
      name: 'Primary',
      timezone: 'Europe/Berlin',
      visibilityScope: 'private',
      isOwner: true,
    });
    expect(body.activityTypes.map((activityType) => activityType.name)).toEqual(['Work']);
    expect(body.windows).toEqual([
      expect.objectContaining({ kind: 'working', weekday: 1, startMin: 480, endMin: 1080 }),
    ]);
    // Five weekdays from the fixture, in weekday order, addressed to the
    // default set rather than to the override.
    expect(body.availability.map((window) => window.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect(body.availability.every((window) => window.weekTypeOverrideId === null)).toBe(true);
    expect(body.weekTypeOverrides.map((override) => override.name)).toEqual(['Conference']);
  });

  it('refuses a calendar in another tenant as if it were not there', async () => {
    const other = await createApiWorld(handle.db);

    // RLS makes "someone else's" and "does not exist" the same answer, which is
    // the answer either way (§5.2).
    const response = await world.get(`/api/calendars/${other.calendarId}/configuration`);
    expect(response.status).toBe(404);
  });

  /**
   * Two reads of the same calendar at once (spec §3.4).
   *
   * The week view asks for the schedule and the backlog together, and every
   * read re-derives and rewrites the placement cache. When the cache was
   * replaced with a delete followed by an insert, the second transaction's
   * delete could not see rows the first had inserted after its statement
   * snapshot was taken — so it removed nothing and then violated
   * `placements_occurrence_key`. An ordinary page load, returning 500,
   * whenever the timing lined up.
   */
  it('survives concurrent reads that both re-derive', async () => {
    await createTask('Report');
    await createTask('Review');

    const responses = await Promise.all([
      world.get(`/api/calendars/${world.calendarId}/schedule`),
      world.get(`/api/calendars/${world.calendarId}/backlog`),
      world.get(`/api/calendars/${world.calendarId}/schedule`),
      world.get(`/api/calendars/${world.calendarId}/capacity`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);

    // And the cache is left holding one row per placed occurrence, not two.
    const schedule = scheduleResponseSchema.parse(await responses[0]!.json());
    const cached = await withSystemPrivileges(handle.db, (tx) =>
      tx
        .select({ occurrenceId: placements.occurrenceId })
        .from(placements)
        .where(eq(placements.calendarId, world.calendarId)),
    );

    expect(cached).toHaveLength(schedule.schedule.blocks.length);
    expect(new Set(cached.map((row) => row.occurrenceId)).size).toBe(cached.length);
  });
});
