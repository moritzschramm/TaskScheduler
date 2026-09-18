import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, solve } from '@ambitime/scheduler';
import { placements, tasks } from '../../src/db/schema/index.js';
import { loadScheduleContext, toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, MONDAY_0900, readCachedPlacements, type World } from '../support/world.js';
import type { CreateTaskParams } from '@ambitime/shared';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Derived state (spec §3.4): the schedule is a function of the source, and the
 * placement cache is only a materialisation of it.
 *
 * The strongest way to say that is to throw the cache away and rebuild it. If
 * the rebuilt answer differs, then something in the cache was never derived —
 * it was patched, or it drifted, and the architecture's central claim is false.
 */
describe('the cache holds nothing the source does not imply', () => {
  let handle: DatabaseHandle;
  let world: World;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createWorld(handle, { defaultCooldownMin: 15 });
  });

  const create = (title: string, params: Partial<CreateTaskParams> = {}) =>
    world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 90,
        ...params,
      },
    });

  async function seedAVariedWeek(): Promise<void> {
    await create('Report', {
      priority: 4,
      dueDate: { date: '2026-03-25T12:00:00Z', kind: 'soft' },
    });
    await create('Email', { estimatedDurationMin: 30 });
    await create('Deep work', { estimatedDurationMin: 180, focusLevel: 5 });
    await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Standup',
        start: '2026-03-24T08:00:00Z',
        end: '2026-03-24T08:30:00Z',
      },
    });
    const [report] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Report')).limit(1),
    );
    await world.run({
      type: 'MoveTask',
      params: { taskId: report!.id, datetime: '2026-03-24T10:00:00Z' },
    });
  }

  it('reproduces the cache exactly from source alone', async () => {
    await seedAVariedWeek();

    const { cached, recomputed } = await world.read(async (tx) => {
      const { context } = await loadScheduleContext({
        tx,
        calendarId: world.calendarId,
        now: toInstant(MONDAY_0900),
        config: DEFAULT_TUNING,
      });

      return {
        cached: await readCachedPlacements(tx, world.calendarId),
        recomputed: solve(context, { config: DEFAULT_TUNING }).placements,
      };
    });

    expect(cached).toHaveLength(3);
    expect(cached).toEqual(recomputed);
  });

  it('derives the same schedule twice from the same source and the same now', async () => {
    await seedAVariedWeek();
    const first = await world.cachedPlacements();

    // An edit that changes nothing still runs the whole pipeline.
    const [email] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Email')).limit(1),
    );
    await world.run({ type: 'EditTask', params: { taskId: email!.id, patch: {} } });

    expect(await world.cachedPlacements()).toEqual(first);
  });

  it('gives two worlds built by the same commands the same shape of schedule', async () => {
    await seedAVariedWeek();
    const first = await world.cachedPlacements();

    const twin = await createWorld(handle, { defaultCooldownMin: 15 });
    const previous = world;
    world = twin;
    await seedAVariedWeek();
    world = previous;

    // Occurrence ids differ between worlds — they are database-generated — so
    // what has to match is the schedule itself: the same intervals, occupied in
    // the same order.
    const shape = (list: Awaited<ReturnType<World['cachedPlacements']>>) =>
      list.map((placement) => [placement.interval.start, placement.interval.end]);

    expect(shape(await twin.cachedPlacements())).toEqual(shape(first));
  });

  it('replaces the cache rather than accumulating rows', async () => {
    await seedAVariedWeek();
    for (let round = 0; round < 3; round += 1) {
      await create(`Extra ${round}`, { estimatedDurationMin: 30 });
    }

    const rows = await world.read((tx) =>
      tx
        .select({ occurrenceId: placements.occurrenceId })
        .from(placements)
        .where(eq(placements.calendarId, world.calendarId)),
    );
    expect(new Set(rows.map((row) => row.occurrenceId)).size).toBe(rows.length);
  });
});

describe('the estimated week tracks the backlog (spec §6.1)', () => {
  let handle: DatabaseHandle;
  let world: World;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createWorld(handle);
  });

  it('is written when a task backlogs and cleared when it fits again', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Overflowing',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
      },
    });
    const [task] = await world.read((tx) =>
      tx.select({ id: tasks.id, version: tasks.version }).from(tasks).limit(1),
    );

    await world.run({ type: 'DeferTask', params: { taskId: task!.id, target: 'backlog' } });
    let [row] = await world.read((tx) =>
      tx.select({ week: tasks.estimatedWeek }).from(tasks).limit(1),
    );
    expect(row!.week).toBe('2026-04-06');

    // Bringing it back inside the horizon must clear the estimate, or a backlog
    // view would keep listing a task that is on the calendar.
    await world.run({
      type: 'MoveTask',
      params: { taskId: task!.id, datetime: '2026-03-24T08:00:00Z' },
    });
    [row] = await world.read((tx) => tx.select({ week: tasks.estimatedWeek }).from(tasks).limit(1));
    expect(row!.week).toBeNull();
  });

  it('does not bump a task’s version when re-derivation changes nothing', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Stable',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
      },
    });
    const [before] = await world.read((tx) =>
      tx.select({ id: tasks.id, version: tasks.version }).from(tasks).limit(1),
    );

    // Three commands that touch other things entirely. A derived write on every
    // re-derive would invalidate every client's held version (§5.4) and
    // manufacture conflicts out of nothing.
    for (const title of ['Other A', 'Other B', 'Other C']) {
      await world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title,
          activityTypeId: world.activityTypeId,
          estimatedDurationMin: 30,
        },
      });
    }

    const [after] = await world.read((tx) =>
      tx.select({ version: tasks.version }).from(tasks).where(eq(tasks.id, before!.id)).limit(1),
    );
    expect(after!.version).toBe(before!.version);
  });
});
