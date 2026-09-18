import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import type * as DeriveModule from '../../src/schedule/derive.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * How many times one request solves the calendar (spec §3.3, §6.1).
 *
 * Re-derivation is cheap enough to do on every read, which is the design and
 * the right one — but "cheap" is a budget rather than a licence, and it was
 * being spent several times over for a single screen. A page load ran three
 * solves of the same fortnight, because the backlog and the capacity reading
 * were fetched from endpoints that each recomputed the whole schedule to
 * return one field of it. A command ran two, because the apply pipeline
 * re-derived to read back what the refresh had just produced.
 *
 * None of that was visible in any assertion: every response was correct, and a
 * fourth caller could be added tomorrow without a single test noticing. So the
 * count is the assertion. It spies on the one function that does the work, and
 * fails when a request starts doing it twice.
 */

const derive = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../src/schedule/derive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DeriveModule>();

  return {
    ...actual,
    deriveCalendarSchedule: (...args: Parameters<typeof actual.deriveCalendarSchedule>) => {
      derive.calls += 1;
      return actual.deriveCalendarSchedule(...args);
    },
  };
});

describe('how often a request solves', () => {
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
    derive.calls = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function seedTask(): Promise<void> {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Write the report',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
      },
    } as never);
  }

  it('solves once for the schedule, and answers the whole screen with it', async () => {
    await seedTask();
    derive.calls = 0;

    const response = await world.get(`/api/calendars/${world.calendarId}/schedule`);
    expect(response.status).toBe(200);

    expect(derive.calls).toBe(1);

    // The two readings that used to cost a solve each. Both are products of
    // this one, which is also why they cannot disagree with it (§6.6).
    const body = (await response.json()) as {
      schedule: { blocks: unknown[]; backlog: unknown[] };
      capacity: { activityTypeId: string }[];
    };
    expect(body.schedule.blocks).toHaveLength(1);
    expect(body.schedule.backlog).toEqual([]);
    expect(body.capacity.some((cell) => cell.activityTypeId === world.activityTypeId)).toBe(true);
  });

  it('solves once for a command, not once to apply and again to report', async () => {
    await seedTask();
    derive.calls = 0;

    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Second',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 30,
      },
    } as never);

    // One calendar touched, one solve. The refresh generates the demand and
    // derives; what it returns is what the caller is told.
    expect(derive.calls).toBe(1);
  });

  it('still reports the schedule the command produced', async () => {
    const outcome = await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Only',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 45,
      },
    } as never);

    // The point of the second derive was to answer with a schedule including
    // whatever the refresh spawned; reusing the first must not lose that.
    expect(outcome.schedules[0]!.blocks.map((block) => block.title)).toEqual(['Only']);
  });

  it('solves once per calendar the command touched, and no more', async () => {
    const second = await world.run({
      type: 'CreateCalendar',
      params: { name: 'Second', timezone: 'Europe/Berlin' },
    } as never);
    const secondId = second.created.find((row) => row.entity === 'calendar')!.id;
    derive.calls = 0;

    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: secondId,
        title: 'Elsewhere',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 30,
      },
    } as never);

    expect(derive.calls).toBe(1);
  });
});
