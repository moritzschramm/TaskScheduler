import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '../../src/commands/index.js';
import { appointments, taskOccurrences, tasks } from '../../src/db/schema/index.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import {
  createWorld,
  MONDAY_0900,
  placementOf,
  seedTask,
  taskRow,
  validatePersistedSchedule,
  type World,
} from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The rest of §7.3 and §7.4, one command at a time.
 *
 * Each of these is tested through its *effect on the schedule*, not through the
 * column it happened to write. A command that stored the right value and
 * changed nothing about where the work sits would have failed at the only thing
 * it exists to do.
 */
describe('the remaining §7.3–7.4 commands', () => {
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

  describe('ExtendTask (§7.3, §7.6)', () => {
    it('grows the task and reflows what was behind it', async () => {
      const first = await seedTask(world, 'Overran');
      const second = await seedTask(world, 'Behind it');

      const before = await placementOf(world, second);

      await world.run({ type: 'ExtendTask', params: { taskId: first, newEstimateMin: 120 } });

      const grown = await placementOf(world, first);
      const pushed = await placementOf(world, second);

      expect(grown!.interval.end - grown!.interval.start).toBe(120);
      // The estimate proving wrong mid-day is §7.6's scenario: everything
      // downstream moves, and nobody had to ask it to.
      expect(pushed!.interval.start).toBeGreaterThan(before!.interval.start);
      expect(pushed!.interval.start).toBeGreaterThanOrEqual(grown!.interval.end);
    });

    it('refuses a parent, whose duration rolls up from its children', async () => {
      const parent = await seedTask(world, 'Project');
      await seedTask(world, 'Subtask', { parentId: parent });

      await expect(
        world.run({ type: 'ExtendTask', params: { taskId: parent, newEstimateMin: 120 } }),
      ).rejects.toBeInstanceOf(PreconditionFailedError);
    });
  });

  describe('CancelTask (§7.3)', () => {
    it('frees the footprint without pretending the task was done', async () => {
      const cancelled = await seedTask(world, 'Dropped');
      const other = await seedTask(world, 'Still on');

      await world.run({ type: 'CancelTask', params: { taskId: cancelled } });

      const row = await taskRow(world, cancelled);
      expect(row.status).toBe('cancelled');
      // Not completed, and no completion time invented for it.
      expect(row.completedAt).toBeNull();
      expect(await placementOf(world, cancelled)).toBeUndefined();

      // The time it gave back is usable: the survivor takes the front of the day.
      const survivor = await placementOf(world, other);
      expect(survivor!.interval.start).toBe(toInstant(MONDAY_0900));
    });

    it('cascades to the subtree, because a branch has no footprint of its own', async () => {
      const parent = await seedTask(world, 'Project');
      const child = await seedTask(world, 'Subtask', { parentId: parent });
      const grandchild = await seedTask(world, 'Sub-subtask', { parentId: child });

      await world.run({ type: 'CancelTask', params: { taskId: parent } });

      for (const id of [parent, child, grandchild]) {
        expect((await taskRow(world, id)).status).toBe('cancelled');
      }

      const occurrences = await world.read((tx) =>
        tx
          .select({ status: taskOccurrences.status })
          .from(taskOccurrences)
          .innerJoin(tasks, eq(tasks.id, taskOccurrences.taskId))
          .where(eq(tasks.calendarId, world.calendarId)),
      );
      expect(occurrences.every((row) => row.status === 'cancelled')).toBe(true);
      expect(await world.cachedPlacements()).toEqual([]);
    });

    it('refuses a task that is already cancelled', async () => {
      const taskId = await seedTask(world, 'Dropped');
      await world.run({ type: 'CancelTask', params: { taskId } });

      await expect(world.run({ type: 'CancelTask', params: { taskId } })).rejects.toBeInstanceOf(
        PreconditionFailedError,
      );
    });
  });

  describe('MoveToBacklog and PromoteFromBacklog (§7.3, §6.1)', () => {
    it('pushes a task past the horizon and gives it an estimated week', async () => {
      const taskId = await seedTask(world, 'Later');

      await world.run({ type: 'MoveToBacklog', params: { taskId } });

      expect(await placementOf(world, taskId)).toBeUndefined();
      const row = await taskRow(world, taskId);
      expect(row.estimatedWeek).not.toBeNull();
      // Not a deferral: §6.6's counter tracks a user avoiding a task, and
      // deciding which fortnight something belongs to is not that.
      expect(row.deferCount).toBe(0);
    });

    it('brings it back, and re-derivation places it again', async () => {
      const taskId = await seedTask(world, 'Later');
      await world.run({ type: 'MoveToBacklog', params: { taskId } });

      await world.run({ type: 'PromoteFromBacklog', params: { taskId } });

      const row = await taskRow(world, taskId);
      expect(row.manualFloor).toBeNull();
      expect(row.estimatedWeek).toBeNull();
      expect(await placementOf(world, taskId)).toBeDefined();
    });

    it('leaves a floor that points inside the horizon alone', async () => {
      // That floor is a reposition the user made for their own reasons, and is
      // not what put the task in the backlog — so promoting must not discard it.
      const taskId = await seedTask(world, 'Repositioned');
      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-24T09:00:00Z' } });

      await world.run({ type: 'PromoteFromBacklog', params: { taskId } });

      expect(toInstant((await taskRow(world, taskId)).manualFloor!)).toBe(
        toInstant('2026-03-24T09:00:00Z'),
      );
    });
  });

  describe('AddUnavailability (§7.4)', () => {
    it('blocks the time and makes tasks reflow around it', async () => {
      const taskId = await seedTask(world, 'Work');
      expect((await placementOf(world, taskId))!.interval.start).toBe(toInstant(MONDAY_0900));

      await world.run({
        type: 'AddUnavailability',
        params: {
          calendarId: world.calendarId,
          start: '2026-03-23T08:00:00Z',
          end: '2026-03-23T10:00:00Z',
        },
      });

      expect((await placementOf(world, taskId))!.interval.start).toBe(
        toInstant('2026-03-23T10:00:00Z'),
      );
      expect(await validatePersistedSchedule(world)).toMatchObject({ valid: true });
    });

    it('stores no title rather than inventing one', async () => {
      await world.run({
        type: 'AddUnavailability',
        params: {
          calendarId: world.calendarId,
          start: '2026-03-23T13:00:00Z',
          end: '2026-03-23T15:00:00Z',
        },
      });

      const [row] = await world.read((tx) =>
        tx
          .select({ title: appointments.title, flag: appointments.isUnavailability })
          .from(appointments)
          .limit(1),
      );

      expect(row).toEqual({ title: '', flag: true });
    });

    it('may cover a block that is already there', async () => {
      await world.run({
        type: 'AddAppointment',
        params: {
          calendarId: world.calendarId,
          title: 'Standup',
          start: '2026-03-23T09:00:00Z',
          end: '2026-03-23T09:30:00Z',
        },
      });

      // "I am not here this morning" is a true thing to say about a morning
      // that has a standup in it — and it leaves the standup for its owner to
      // deal with rather than deleting it (§7.2, migration 0016).
      await expect(
        world.run({
          type: 'AddUnavailability',
          params: {
            calendarId: world.calendarId,
            start: '2026-03-23T09:15:00Z',
            end: '2026-03-23T11:00:00Z',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('keeps the title the user gave it', async () => {
      await world.run({
        type: 'AddUnavailability',
        params: {
          calendarId: world.calendarId,
          title: 'School run',
          start: '2026-03-23T13:00:00Z',
          end: '2026-03-23T15:00:00Z',
        },
      });

      const [row] = await world.read((tx) =>
        tx
          .select({ title: appointments.title, flag: appointments.isUnavailability })
          .from(appointments)
          .limit(1),
      );

      expect(row).toEqual({ title: 'School run', flag: true });
    });
  });
});
