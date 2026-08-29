import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { taskListSchema } from '@ambitime/shared';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * `GET /api/calendars/:id/tasks` (spec §4.4).
 *
 * A source read, not a derived one, and that is the point of it existing: the
 * panel has to show tasks the schedule cannot contain — a parent, something
 * completed, something with no estimate yet.
 */
describe('the task list', () => {
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

  const create = (title: string, extra: Record<string, unknown> = {}) =>
    world.run({
      type: 'CreateTask',
      params: { calendarId: world.calendarId, title, ...extra },
    } as never);

  it('returns the tree with own and effective values', async () => {
    await create('Project', {
      categoryId: world.categoryId,
      dueDate: { date: '2026-04-01T12:00:00Z', kind: 'soft' },
    });

    const listed = taskListSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/tasks`)).json(),
    );
    const parentId = listed.tasks[0]!.id;

    await create('Subtask', { parentId, estimatedDurationMin: 60 });

    const body = taskListSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/tasks`)).json(),
    );

    expect(body.tasks.map((task) => task.title)).toEqual(['Project', 'Subtask']);

    const child = body.tasks[1]!;
    // The child sets neither, and gets both from its parent — which is what a
    // panel needs to show as inherited rather than as chosen here (§4.4).
    expect(child.ownCategoryId).toBeNull();
    expect(child.effectiveCategoryId).toBe(world.categoryId);
    expect(child.ownDueDate).toBeNull();
    expect(child.effectiveDueDate).toBe('2026-04-01T12:00:00.000Z');
    expect(child).toMatchObject({ depth: 2, isLeaf: true, parentId });
    expect(body.tasks[0]).toMatchObject({ depth: 1, isLeaf: false });
  });

  it('includes tasks the schedule cannot contain', async () => {
    await create('Done', { categoryId: world.categoryId, estimatedDurationMin: 30 });
    const listed = taskListSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/tasks`)).json(),
    );
    await world.run({ type: 'CompleteTask', params: { taskId: listed.tasks[0]!.id } });

    const body = taskListSchema.parse(
      await (await world.get(`/api/calendars/${world.calendarId}/tasks`)).json(),
    );

    expect(body.tasks[0]?.status).toBe('completed');
  });
});
