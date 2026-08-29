import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema/index.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, validatePersistedSchedule, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The bulk deferral family (spec §7.2) — the sick day and the vacation.
 *
 * Two things matter beyond "the tasks moved". First, that a bulk reflow clears
 * the floors the user had set by hand (§7.3): without that, the tasks the user
 * cared enough to position are precisely the ones that would snap back onto the
 * day being cleared. Second, that none of this counts as a deferral (§6.6) —
 * being ill is not avoiding your work.
 */
describe('PostponeRestOfDay', () => {
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

  /** Three two-hour tasks fill Monday 09:00–15:00 Berlin. */
  async function seedMonday(): Promise<string[]> {
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      await world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title,
          categoryId: world.categoryId,
          estimatedDurationMin: 120,
        },
      });
    }

    const rows = await world.read((tx) =>
      tx.select({ id: tasks.id, title: tasks.title }).from(tasks).orderBy(tasks.title),
    );
    return rows.map((row) => row.id);
  }

  const postpone = (at: string) =>
    world.run(
      { type: 'PostponeRestOfDay', params: { calendarId: world.calendarId, date: '2026-03-23' } },
      { at },
    );

  it('moves the whole day into the days after it', async () => {
    await seedMonday();
    expect((await world.cachedPlacements())[0]!.interval.start).toBe(
      toInstant('2026-03-23T08:00:00Z'),
    );

    const outcome = await postpone('2026-03-23T08:00:00Z');

    // Tuesday 09:00 Berlin onwards; nothing left on Monday.
    const starts = outcome.schedules[0]!.placements.map((p) => p.interval.start);
    expect(Math.min(...starts)).toBe(toInstant('2026-03-24T08:00:00Z'));
    expect(await validatePersistedSchedule(world, '2026-03-23T08:00:00Z')).toEqual({
      valid: true,
      violations: [],
    });
  });

  it('leaves the task under way at `now` exactly where it is', async () => {
    const [alpha] = await seedMonday();

    // 10:00 Berlin: Alpha is running (09:00–11:00), Beta and Gamma are not.
    await postpone('2026-03-23T09:00:00Z');

    const rows = await world.read((tx) =>
      tx.select({ id: tasks.id, floor: tasks.manualFloor }).from(tasks),
    );
    const floors = new Map(rows.map((row) => [row.id, row.floor]));
    expect(floors.get(alpha!)).toBeNull();
    expect([...floors.values()].filter((floor) => floor !== null)).toHaveLength(2);
  });

  it('clears a floor the user had set by hand, rather than fighting it (spec §7.3)', async () => {
    const ids = await seedMonday();
    // The user pins Beta to Monday afternoon...
    await world.run({
      type: 'MoveTask',
      params: { taskId: ids[1]!, datetime: '2026-03-23T12:00:00Z' },
    });

    // ...and then calls in sick. The pin must not survive, or Beta lands back
    // on the very day being cleared.
    await postpone('2026-03-23T08:00:00Z');

    const [beta] = await world.read((tx) =>
      tx
        .select({ floor: tasks.manualFloor, bias: tasks.manualBias })
        .from(tasks)
        .where(eq(tasks.id, ids[1]!))
        .limit(1),
    );
    expect(toInstant(beta!.floor!)).toBe(toInstant('2026-03-23T23:00:00Z'));
    expect(beta!.bias).toBeNull();
  });

  it('counts as an involuntary reflow, not a deferral (spec §6.6)', async () => {
    const ids = await seedMonday();

    await postpone('2026-03-23T08:00:00Z');
    await postpone('2026-03-23T08:00:00Z');

    const rows = await world.read((tx) =>
      tx.select({ deferCount: tasks.deferCount }).from(tasks).where(inArray(tasks.id, ids)),
    );
    expect(rows.map((row) => row.deferCount)).toEqual([0, 0, 0]);
  });

  it('names the appointments it deliberately did not move (spec §7.2)', async () => {
    await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Client call',
        start: '2026-03-23T12:00:00Z',
        end: '2026-03-23T13:00:00Z',
        isInternal: false,
      },
    });

    const outcome = await postpone('2026-03-23T08:00:00Z');

    expect(outcome.attention).toEqual([
      expect.objectContaining({
        kind: 'appointment_needs_rescheduling',
        title: 'Client call',
        isInternal: false,
      }),
    ]);
  });

  it('does nothing to a day that is already over', async () => {
    await seedMonday();

    // Issued on Wednesday, naming Monday.
    const outcome = await postpone('2026-03-25T08:00:00Z');

    const floors = await world.read((tx) => tx.select({ floor: tasks.manualFloor }).from(tasks));
    expect(floors.every((row) => row.floor === null)).toBe(true);
    expect(outcome.attention).toEqual([]);
  });
});

describe('ClearWeek', () => {
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

  it('pushes the week’s work into later weeks', async () => {
    for (const title of ['One', 'Two']) {
      await world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title,
          categoryId: world.categoryId,
          estimatedDurationMin: 120,
        },
      });
    }

    const outcome = await world.run({
      type: 'ClearWeek',
      // Any date in the week; the server snaps to the week's start (§13).
      params: { calendarId: world.calendarId, week: '2026-03-25' },
    });

    // Monday 2026-03-30, 09:00 Berlin — summer time, so 07:00Z.
    const starts = outcome.schedules[0]!.placements.map((p) => p.interval.start);
    expect(Math.min(...starts)).toBe(toInstant('2026-03-30T07:00:00Z'));
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('sends work to the backlog when no later week in the horizon can hold it', async () => {
    // A single window of two hours a week, and a task needing all of it.
    const narrow = await createWorld(handle, {
      window: { startMin: 9 * 60, endMin: 11 * 60, weekdays: [1] },
    });
    await narrow.run({
      type: 'CreateTask',
      params: {
        calendarId: narrow.calendarId,
        title: 'Weekly ritual',
        categoryId: narrow.categoryId,
        estimatedDurationMin: 120,
      },
    });

    const outcome = await narrow.run({
      type: 'ClearWeek',
      params: { calendarId: narrow.calendarId, week: '2026-03-23' },
    });

    // Week two of the horizon still fits it, so this is not yet a backlog case.
    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-30T07:00:00Z'),
    );

    const backlogged = await narrow.run({
      type: 'ClearWeek',
      params: { calendarId: narrow.calendarId, week: '2026-03-30' },
    });
    expect(backlogged.schedules[0]!.placements).toHaveLength(0);
    expect(backlogged.schedules[0]!.backlog[0]!.estimatedWeek).toBe('2026-04-06');
  });
});
