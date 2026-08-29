import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '../../src/commands/index.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import {
  createWorld,
  placementOf,
  seedTask,
  taskRow,
  validatePersistedSchedule,
  type World,
} from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * `SwapTasks` and `SwapForward` (spec §7.3).
 *
 * These are the two commands whose subject — a task's *position* — is not
 * something the system stores. So the tests are written against positions, and
 * the point of every one of them is that the exchange the user asked for came
 * out of re-derivation rather than out of anything being pinned.
 */
describe('the swap actions', () => {
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

  /** The two seeded tasks, in the order the solver actually placed them. */
  async function twoInOrder(): Promise<{ early: string; late: string; starts: number[] }> {
    const one = await seedTask(world, 'One');
    const two = await seedTask(world, 'Two');

    const placedOne = await placementOf(world, one);
    const placedTwo = await placementOf(world, two);
    const earlyFirst = placedOne!.interval.start <= placedTwo!.interval.start;

    return {
      early: earlyFirst ? one : two,
      late: earlyFirst ? two : one,
      starts: [placedOne!.interval.start, placedTwo!.interval.start].sort((a, b) => a - b),
    };
  }

  describe('SwapForward — "I don\'t want to work on this now"', () => {
    it('moves the task past its slot and lets the next one take it', async () => {
      const { early, late, starts } = await twoInOrder();

      await world.run({ type: 'SwapForward', params: { taskId: early } });

      // Both halves of §7.3 out of a single floor: the task moved on, and the
      // slot it left did not stay empty.
      expect((await placementOf(world, early))!.interval.start).toBe(starts[1]);
      expect((await placementOf(world, late))!.interval.start).toBe(starts[0]);
      expect(await validatePersistedSchedule(world)).toMatchObject({ valid: true });
    });

    it('drops the bias, which pointed at the slot just refused', async () => {
      const { early } = await twoInOrder();
      await world.run({
        type: 'MoveTask',
        params: { taskId: early, datetime: '2026-03-23T08:00:00Z' },
      });

      await world.run({ type: 'SwapForward', params: { taskId: early } });

      const row = await taskRow(world, early);
      expect(row.manualBias).toBeNull();
      expect(row.manualFloor).not.toBeNull();
    });

    it('leaves defer_count alone — §6.6 is about tasks that never get done', async () => {
      const { early } = await twoInOrder();

      await world.run({ type: 'SwapForward', params: { taskId: early } });

      expect((await taskRow(world, early)).deferCount).toBe(0);
    });

    it('refuses a task that holds no slot to move out of', async () => {
      const taskId = await seedTask(world, 'Backlogged');
      await world.run({ type: 'MoveToBacklog', params: { taskId } });

      await expect(world.run({ type: 'SwapForward', params: { taskId } })).rejects.toBeInstanceOf(
        PreconditionFailedError,
      );
    });
  });

  describe('SwapTasks — trade places, if each fits the other slot', () => {
    it('exchanges two tasks that fit each other constraints', async () => {
      const { early, late, starts } = await twoInOrder();

      await world.run({ type: 'SwapTasks', params: { taskAId: early, taskBId: late } });

      expect((await placementOf(world, early))!.interval.start).toBe(starts[1]);
      expect((await placementOf(world, late))!.interval.start).toBe(starts[0]);

      // Floor *and* bias, as §7.3's manual reposition sets them: neither task is
      // fixed there, and a hard constraint could still move either.
      const moved = await taskRow(world, early);
      expect(toInstant(moved.manualFloor!)).toBe(starts[1]);
      expect(toInstant(moved.manualBias!)).toBe(starts[1]);
      expect(await validatePersistedSchedule(world)).toMatchObject({ valid: true });
    });

    it('falls back to SwapForward when one task will not fit the other slot', async () => {
      // A 90-minute task cannot take the 60-minute one's slot: an appointment
      // starts an hour into it.
      await world.run({
        type: 'AddAppointment',
        params: {
          calendarId: world.calendarId,
          title: 'Standup',
          start: '2026-03-23T09:00:00Z',
          end: '2026-03-23T10:00:00Z',
        },
      });
      const short = await seedTask(world, 'Short');
      const long = await seedTask(world, 'Long', { estimatedDurationMin: 90 });

      const shortSlot = await placementOf(world, short);
      const longSlot = await placementOf(world, long);
      expect(shortSlot!.interval.start).toBeLessThan(longSlot!.interval.start);

      await world.run({ type: 'SwapTasks', params: { taskAId: short, taskBId: long } });

      // The signature of the fallback, and not of a swap: a floor at the end of
      // the slot it held, and no bias. A swap would have set both, to the
      // other's start.
      const row = await taskRow(world, short);
      expect(toInstant(row.manualFloor!)).toBe(shortSlot!.interval.end);
      expect(row.manualBias).toBeNull();
      expect((await taskRow(world, long)).manualFloor).toBeNull();
      expect(await validatePersistedSchedule(world)).toMatchObject({ valid: true });
    });

    it('falls back when the other task holds no slot at all', async () => {
      const placed = await seedTask(world, 'Placed');
      const backlogged = await seedTask(world, 'Backlogged');
      await world.run({ type: 'MoveToBacklog', params: { taskId: backlogged } });
      const slot = await placementOf(world, placed);

      await world.run({ type: 'SwapTasks', params: { taskAId: placed, taskBId: backlogged } });

      expect(toInstant((await taskRow(world, placed)).manualFloor!)).toBe(slot!.interval.end);
    });

    it('refuses when the task named first holds no slot either', async () => {
      const a = await seedTask(world, 'One');
      const b = await seedTask(world, 'Two');
      await world.run({ type: 'MoveToBacklog', params: { taskId: a } });

      await expect(
        world.run({ type: 'SwapTasks', params: { taskAId: a, taskBId: b } }),
      ).rejects.toBeInstanceOf(PreconditionFailedError);
    });
  });
});
