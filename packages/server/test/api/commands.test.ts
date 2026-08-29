import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorResponseSchema, commandResultSchema, uuidv7 } from '@ambitime/shared';
import { tasks } from '../../src/db/schema/index.js';
import { withSystemPrivileges } from '../../src/db/context.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * `POST /api/commands` — the only way in (spec §3.2).
 *
 * What is under test is the layer M9 adds, not the command layer beneath it:
 * that the envelope is completed from the session rather than the body, that
 * the shared Zod schema is what rejects a malformed payload, that the result
 * comes back in the shape the shared schema promises, and that each way of
 * failing arrives as its own code.
 */
describe('the command endpoint', () => {
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

  it('creates a task and returns a schedule matching the scheduler', async () => {
    const result = await createTask('Write the report');

    // Parsed with the shared schema: the server's response and the client's
    // expectation come from one definition (§3.1).
    const parsed = commandResultSchema.parse(result);
    expect(parsed.schedules).toHaveLength(1);

    const [schedule] = parsed.schedules;
    expect(schedule?.blocks).toHaveLength(1);
    expect(schedule?.blocks[0]).toMatchObject({
      title: 'Write the report',
      // Monday 09:00 Berlin, the front of the first window.
      start: '2026-03-23T08:00:00.000Z',
      end: '2026-03-23T09:00:00.000Z',
    });
    // Enriched server-side: a placement alone carries no title.
    expect(schedule?.blocks[0]?.taskId).not.toBe('');
  });

  it('takes the actor and tenant from the session, not from the body', async () => {
    await createTask('Mine');

    const [row] = await withSystemPrivileges(handle.db, (tx) =>
      tx.select({ ownerId: tasks.ownerId, tenantId: tasks.tenantId }).from(tasks),
    );

    expect(row).toEqual({ ownerId: world.userId, tenantId: world.tenantId });
  });

  it('carries a manual action through to the derived schedule', async () => {
    await createTask('Repositioned');
    const [task] = await withSystemPrivileges(handle.db, (tx) =>
      tx.select({ id: tasks.id }).from(tasks),
    );

    const result = await world.run({
      type: 'MoveTask',
      params: { taskId: task!.id, datetime: '2026-03-24T13:00:00Z' },
    });

    expect(result.schedules[0]?.blocks[0]?.start).toBe('2026-03-24T13:00:00.000Z');
  });

  it('rejects a malformed payload through the shared schema', async () => {
    const response = await world.command({
      type: 'CreateTask',
      params: { calendarId: world.calendarId, title: '' },
    } as never);

    expect(response.status).toBe(400);
    const body = errorResponseSchema.parse(await response.json());
    expect(body.error.code).toBe('invalid_request');
    // Field-level, so a form can point at the offending input.
    expect(body.error.details?.some((detail) => detail.path.includes('title'))).toBe(true);
  });

  it('rejects a command type that does not exist', async () => {
    const response = await world.command({ type: 'DropDatabase', params: {} } as never);

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('invalid_request');
  });

  it('surfaces an optimistic-lock conflict with both versions', async () => {
    await createTask('Contested');
    const [task] = await withSystemPrivileges(handle.db, (tx) =>
      tx.select({ id: tasks.id, version: tasks.version }).from(tasks),
    );

    const response = await world.command({
      type: 'EditTask',
      expectedVersion: task!.version + 7,
      params: { taskId: task!.id, patch: { title: 'Renamed' } },
    });

    expect(response.status).toBe(409);
    const body = errorResponseSchema.parse(await response.json());
    expect(body.error).toMatchObject({
      code: 'version_conflict',
      expectedVersion: task!.version + 7,
      actualVersion: task!.version,
    });
  });

  it('surfaces a precondition failure as its own code', async () => {
    await createTask('Parent');
    const [parent] = await withSystemPrivileges(handle.db, (tx) =>
      tx.select({ id: tasks.id }).from(tasks),
    );
    await createTask('Child', { parentId: parent!.id });

    const response = await world.command({
      type: 'MoveTask',
      params: { taskId: parent!.id, datetime: '2026-03-24T09:00:00Z' },
    });

    expect(response.status).toBe(409);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('precondition_failed');
  });

  it('reports a task nobody can schedule rather than dropping it', async () => {
    // No category, so the solver was never offered it (§6.7). The distinction
    // matters to a user: this is a data problem, not a busy calendar.
    const result = await world.run({
      type: 'CreateTask',
      params: { calendarId: world.calendarId, title: 'Vague', estimatedDurationMin: 60 },
    });

    expect(result.schedules[0]?.unschedulable).toEqual([
      expect.objectContaining({ reason: 'no_category' }),
    ]);
  });

  it('refuses the same command id twice', async () => {
    const id = uuidv7();
    const body = {
      id,
      type: 'CreateTask' as const,
      params: {
        calendarId: world.calendarId,
        title: 'Once',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    };

    expect((await world.command(body)).status).toBe(200);

    // A retry of a request whose response was lost is refused, not applied
    // twice — the log's primary key is the client's own id (§7.1).
    const retry = await world.command(body);
    expect(retry.status).toBe(409);

    const remaining = await withSystemPrivileges(handle.db, (tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Once')),
    );
    expect(remaining).toHaveLength(1);
  });

  it('turns away a request with no session', async () => {
    const response = await world.app.app.request('/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'Undo', params: {} }),
    });

    expect(response.status).toBe(401);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('unauthenticated');
  });
});
