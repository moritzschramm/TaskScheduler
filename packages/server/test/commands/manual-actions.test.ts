import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '../../src/commands/index.js';
import { taskOccurrences, tasks } from '../../src/db/schema/index.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import {
  createWorld,
  MONDAY_0900,
  validatePersistedSchedule,
  type World,
} from '../support/world.js';
import type { CreateTaskParams } from '@ambitime/shared';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Single-task manual actions (spec §7.3).
 *
 * The claim under test is the architectural one: **a manual edit changes a
 * constraint, it does not freeze an assignment** (§3.4). So the interesting
 * cases are not "the floor was stored" but "the floor was honoured, and then
 * overridden by something that outranks it, and never crossed".
 */
describe('MoveTask — delayed, not fixed', () => {
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

  async function seed(title: string, params: Partial<CreateTaskParams> = {}): Promise<string> {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        ...params,
      },
    });

    const [row] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, title)).limit(1),
    );
    return row!.id;
  }

  const placementOf = async (taskId: string) => {
    const [occurrence] = await world.read((tx) =>
      tx
        .select({ id: taskOccurrences.id })
        .from(taskOccurrences)
        .where(eq(taskOccurrences.taskId, taskId))
        .limit(1),
    );
    const placements = await world.cachedPlacements();
    return placements.find((placement) => placement.occurrenceId === occurrence!.id);
  };

  it('sets a soft floor and a bias, and re-derives to honour both', async () => {
    const taskId = await seed('Repositioned');

    await world.run({
      type: 'MoveTask',
      params: { taskId, datetime: '2026-03-24T13:00:00Z' },
    });

    const [row] = await world.read((tx) =>
      tx
        .select({ floor: tasks.manualFloor, bias: tasks.manualBias })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1),
    );
    expect(toInstant(row!.floor!)).toBe(toInstant('2026-03-24T13:00:00Z'));
    expect(toInstant(row!.bias!)).toBe(toInstant('2026-03-24T13:00:00Z'));

    // Tuesday 14:00 Berlin, exactly where it was dropped.
    expect((await placementOf(taskId))!.interval.start).toBe(toInstant('2026-03-24T13:00:00Z'));
  });

  it('never places the task before its floor, even when earlier time is free', async () => {
    const taskId = await seed('Floored');

    await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T10:00:00Z' } });

    // Monday and Tuesday are wide open, and earliness is a scored preference
    // (§6.5) — but the floor is a hard filter (§6.2 rule 6), so it wins.
    expect((await placementOf(taskId))!.interval.start).toBeGreaterThanOrEqual(
      toInstant('2026-03-25T10:00:00Z'),
    );
  });

  it('is overridable by a hard constraint: the block moves, the floor holds', async () => {
    const taskId = await seed('Bumped', { estimatedDurationMin: 120 });
    await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-24T09:00:00Z' } });
    expect((await placementOf(taskId))!.interval.start).toBe(toInstant('2026-03-24T09:00:00Z'));

    // An appointment lands on exactly where the user put it. The task is not
    // pinned, so it moves — but not back before the floor.
    await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Interview',
        start: '2026-03-24T09:00:00Z',
        end: '2026-03-24T11:00:00Z',
      },
    });

    const moved = await placementOf(taskId);
    expect(moved!.interval.start).toBeGreaterThanOrEqual(toInstant('2026-03-24T11:00:00Z'));
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('refuses to move a parent, which has no placement of its own', async () => {
    const parentId = await seed('Project');
    await seed('Subtask', { parentId });

    await expect(
      world.run({ type: 'MoveTask', params: { taskId: parentId, datetime: MONDAY_0900 } }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });
});

describe('DeferTask — the user-initiated postponement (spec §7.3, §6.6)', () => {
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

  async function seed(): Promise<string> {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Dreaded',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    });
    const [row] = await world.read((tx) => tx.select({ id: tasks.id }).from(tasks).limit(1));
    return row!.id;
  }

  it('pushes to tomorrow and counts the deferral', async () => {
    const taskId = await seed();

    const outcome = await world.run({
      type: 'DeferTask',
      params: { taskId, target: 'tomorrow', reason: 'no energy' },
    });

    // Tuesday 09:00 Berlin — the first slot of the next local day.
    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-24T08:00:00Z'),
    );

    const [row] = await world.read((tx) =>
      tx
        .select({
          deferCount: tasks.deferCount,
          reason: tasks.lastDeferReason,
          bias: tasks.manualBias,
        })
        .from(tasks)
        .limit(1),
    );
    expect(row!.deferCount).toBe(1);
    expect(row!.reason).toBe('no energy');
    // "Sets nothing fixed" (§7.3): no preference is left pointing at a time the
    // user has just rejected.
    expect(row!.bias).toBeNull();
  });

  it('pushes to next week', async () => {
    const taskId = await seed();

    const outcome = await world.run({ type: 'DeferTask', params: { taskId, target: 'next_week' } });

    // Monday 2026-03-30, 09:00 Berlin — and Berlin is on summer time by then,
    // so the correct answer is 07:00Z and not 08:00Z.
    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-30T07:00:00Z'),
    );
  });

  it('pushes past the horizon into the backlog, with an estimated week', async () => {
    const taskId = await seed();

    const outcome = await world.run({ type: 'DeferTask', params: { taskId, target: 'backlog' } });

    expect(outcome.schedules[0]!.placements).toHaveLength(0);
    expect(outcome.schedules[0]!.backlog).toEqual([
      expect.objectContaining({ estimatedWeek: '2026-04-06' }),
    ]);

    const [row] = await world.read((tx) =>
      tx.select({ week: tasks.estimatedWeek }).from(tasks).limit(1),
    );
    expect(row!.week).toBe('2026-04-06');
  });

  it('accumulates towards the chronic-postponement threshold', async () => {
    const taskId = await seed();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await world.run({ type: 'DeferTask', params: { taskId, target: 'tomorrow' } });
    }

    const [row] = await world.read((tx) =>
      tx.select({ deferCount: tasks.deferCount }).from(tasks).limit(1),
    );
    // §15's default N is 3; the signal itself is computed by the engine (§6.6).
    expect(row!.deferCount).toBe(3);
  });
});

describe('CompleteTask (spec §7.3)', () => {
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

  async function seed(title: string): Promise<string> {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: 120,
      },
    });
    const [row] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, title)).limit(1),
    );
    return row!.id;
  }

  it('frees the slot and its cooldown, pulling the day forward (spec §7.6)', async () => {
    const first = await seed('Morning block');
    const second = await seed('Afternoon block');
    expect(await world.cachedPlacements()).toHaveLength(2);

    const outcome = await world.run({
      type: 'CompleteTask',
      params: { taskId: first, actualEnd: '2026-03-23T09:00:00Z' },
    });

    // Only the second remains, and it has moved into the time the first gave
    // back rather than staying where it was.
    expect(outcome.schedules[0]!.placements).toHaveLength(1);
    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(toInstant(MONDAY_0900));
    expect(second).toBeDefined();
  });

  it('clears the manual floor, which is one of the three things that clears one', async () => {
    const taskId = await seed('Positioned then finished');
    await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T10:00:00Z' } });

    await world.run({ type: 'CompleteTask', params: { taskId } });

    const [row] = await world.read((tx) =>
      tx
        .select({ floor: tasks.manualFloor, status: tasks.status, completedAt: tasks.completedAt })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1),
    );
    expect(row!.floor).toBeNull();
    expect(row!.status).toBe('completed');
    expect(row!.completedAt).not.toBeNull();
  });

  it('completes the occurrence too, so it stops being demand', async () => {
    const taskId = await seed('Done');

    await world.run({ type: 'CompleteTask', params: { taskId } });

    const occurrences = await world.read((tx) =>
      tx.select({ status: taskOccurrences.status }).from(taskOccurrences),
    );
    expect(occurrences.map((row) => row.status)).toEqual(['completed']);
  });

  it('refuses to complete a task twice', async () => {
    const taskId = await seed('Once');
    await world.run({ type: 'CompleteTask', params: { taskId } });

    await expect(world.run({ type: 'CompleteTask', params: { taskId } })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });
});
