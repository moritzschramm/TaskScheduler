import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_QUEUE, startWorker, type Worker } from '../../src/jobs/queue.js';
import { resetDomainTables, setupTestDatabase, TEST_DATABASE_URL } from '../support/database.js';
import { createWorld, seedTask, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The queue itself (spec §11).
 *
 * The work a job does is tested next door, against the function directly. What
 * is left to check here is the part only the queue can be wrong about: that the
 * fan-out reaches every calendar, that a job actually runs, and that the worker
 * stops without leaving anything behind.
 *
 * Against real pg-boss and a real Postgres, because a mocked queue would assert
 * that the mock was called.
 */
describe('the background worker', () => {
  let handle: DatabaseHandle;
  let world: World;
  let worker: Worker | undefined;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await worker?.stop();
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createWorld(handle);
  });

  /** Waits for a condition the worker satisfies asynchronously. */
  async function eventually(ready: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The worker did not get there in time');
  }

  it('fans a rollover out to every calendar, and the work lands', async () => {
    const taskId = await seedTask(world, 'Later');
    await world.run({ type: 'MoveToBacklog', params: { taskId } });
    expect(await world.cachedPlacements()).toEqual([]);

    // The clock is a fortnight on, so the parked floor is now inside the
    // horizon and a refresh has something to promote (§6.1).
    worker = await startWorker({
      db: handle.db,
      databaseUrl: TEST_DATABASE_URL,
      clock: () => new Date('2026-04-06T08:00:00Z'),
      // Never, in practice: the schedule is exercised by calling the fan-out
      // rather than by waiting for a Monday.
      rolloverCron: '0 0 1 1 *',
    });

    await worker.runRollover();

    await eventually(async () => (await world.cachedPlacements()).length > 0);

    const placements = await world.cachedPlacements();
    expect(placements).toHaveLength(1);
  });

  it('creates its queues and stops cleanly', async () => {
    worker = await startWorker({
      db: handle.db,
      databaseUrl: TEST_DATABASE_URL,
      rolloverCron: '0 0 1 1 *',
    });

    // The queue has to exist before anything can be sent to it; pg-boss is
    // strict about that, and a worker that started without creating it would
    // fail on the first real job rather than at boot.
    await expect(
      worker.boss.send(REFRESH_QUEUE, {
        tenantId: world.tenantId,
        userId: world.userId,
        calendarId: world.calendarId,
      }),
    ).resolves.not.toBeNull();

    await worker.stop();
    worker = undefined;
  });
});
