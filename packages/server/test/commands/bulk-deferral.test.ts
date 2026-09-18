import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appointments, tasks } from '../../src/db/schema/index.js';
import { isoText, toInstant } from '../../src/schedule/index.js';
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
          activityTypeId: world.activityTypeId,
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
          activityTypeId: world.activityTypeId,
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
        activityTypeId: narrow.activityTypeId,
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

/**
 * `BlockOutDay` (spec §7.2) — the sick day expressed as a fact about the day.
 *
 * The behaviour that matters is not "the tasks moved", which any of these three
 * commands manages. It is that this one works on a day that already has
 * something in it: the exclusion constraint of §5.3 refuses two overlapping
 * blocks in a calendar, so writing the day as one 24-hour row would be rejected
 * by every day with a meeting on it — which is most days anybody blocks out.
 */
describe('BlockOutDay', () => {
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

  /** Three two-hour tasks, which fill Monday 09:00–15:00 Berlin. */
  async function seedMonday(): Promise<void> {
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      await world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title,
          activityTypeId: world.activityTypeId,
          estimatedDurationMin: 120,
        },
      });
    }
  }

  const blockOut = (at: string, date = '2026-03-23') =>
    world.run({ type: 'BlockOutDay', params: { calendarId: world.calendarId, date } }, { at });

  /** The unavailability rows on the calendar, earliest first. */
  async function blocks(): Promise<{ start: number; end: number }[]> {
    const rows = await world.read((tx) =>
      tx
        .select({
          startAt: isoText(sql`lower(${appointments.during})`),
          endAt: isoText(sql`upper(${appointments.during})`),
          isUnavailability: appointments.isUnavailability,
        })
        .from(appointments),
    );

    return rows
      .filter((row) => row.isUnavailability)
      .map((row) => ({ start: toInstant(row.startAt), end: toInstant(row.endAt) }))
      .sort((a, b) => a.start - b.start);
  }

  it('covers the day, and the day’s work leaves it', async () => {
    await seedMonday();

    // Issued on the Sunday, so the whole of Monday is still ahead.
    const outcome = await blockOut('2026-03-22T08:00:00Z');

    // Midnight to midnight, Berlin — 23:00Z the evening before to 23:00Z.
    expect(await blocks()).toEqual([
      { start: toInstant('2026-03-22T23:00:00Z'), end: toInstant('2026-03-23T23:00:00Z') },
    ]);

    const starts = outcome.schedules[0]!.placements.map((p) => p.interval.start);
    expect(Math.min(...starts)).toBe(toInstant('2026-03-24T08:00:00Z'));
    expect(await validatePersistedSchedule(world, '2026-03-22T08:00:00Z')).toEqual({
      valid: true,
      violations: [],
    });
  });

  /**
   * The case a single whole-day block cannot do at all.
   *
   * Without the gaps this is not a worse answer, it is an error: the database
   * refuses the insert and the button reports that the day overlaps something,
   * on the exact day the user most needed it to work.
   */
  it('writes the gaps around what is already booked', async () => {
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

    await blockOut('2026-03-22T08:00:00Z');

    expect(await blocks()).toEqual([
      { start: toInstant('2026-03-22T23:00:00Z'), end: toInstant('2026-03-23T12:00:00Z') },
      { start: toInstant('2026-03-23T13:00:00Z'), end: toInstant('2026-03-23T23:00:00Z') },
    ]);
  });

  it('blocks a day in progress from now on, leaving the morning alone', async () => {
    // 10:00 Berlin on the day itself.
    await blockOut('2026-03-23T09:00:00Z');

    expect(await blocks()).toEqual([
      { start: toInstant('2026-03-23T09:00:00Z'), end: toInstant('2026-03-23T23:00:00Z') },
    ]);
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

    const outcome = await blockOut('2026-03-22T08:00:00Z');

    expect(outcome.attention).toEqual([
      expect.objectContaining({
        kind: 'appointment_needs_rescheduling',
        title: 'Client call',
        isInternal: false,
      }),
    ]);
  });

  it('comes back off with one undo, tasks and all', async () => {
    await seedMonday();
    await blockOut('2026-03-22T08:00:00Z');

    await world.run({ type: 'Undo', params: {} }, { at: '2026-03-22T08:00:00Z' });

    expect(await blocks()).toEqual([]);
    const starts = (await world.cachedPlacements()).map((p) => p.interval.start);
    expect(Math.min(...starts)).toBe(toInstant('2026-03-23T08:00:00Z'));
  });

  it('leaves no floor behind, so it is not a deferral either (spec §6.6)', async () => {
    await seedMonday();
    await blockOut('2026-03-22T08:00:00Z');

    const rows = await world.read((tx) =>
      tx.select({ floor: tasks.manualFloor, deferCount: tasks.deferCount }).from(tasks),
    );
    expect(rows.every((row) => row.floor === null && row.deferCount === 0)).toBe(true);
  });

  it('does nothing to a day that is already over', async () => {
    await seedMonday();

    // Issued on Wednesday, naming Monday.
    const outcome = await blockOut('2026-03-25T08:00:00Z');

    expect(await blocks()).toEqual([]);
    expect(outcome.attention).toEqual([]);
  });
});
