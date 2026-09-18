import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commands, notifications, taskOccurrences } from '../../src/db/schema/index.js';
import { refreshCalendar } from '../../src/jobs/refresh.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, seedTask, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The week-rollover promotion job (spec §6.1, §11).
 *
 * §6.1 gives promotion two triggers: "at week rollover via a scheduled job"
 * and "on demand when the user opens the next week". The second has been a
 * command since M7; this is the first, and it closes the gap M13 and M14a both
 * left — signals and recurring demand only advanced when a command happened to
 * arrive, so a calendar nobody touched over a weekend woke on Monday with last
 * fortnight's plan and last fortnight's warnings.
 *
 * The queue itself is not exercised here. What pg-boss adds is delivery, and
 * what delivery has to be safe for is *repetition* — so what these hold is the
 * property that makes at-least-once acceptable, rather than the library that
 * depends on it.
 */
describe('bringing a calendar up to date', () => {
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

  const refreshAt = (at: string) =>
    refreshCalendar({
      db: world.db,
      tenantId: world.tenantId,
      userId: world.userId,
      calendarId: world.calendarId,
      now: toInstant(at),
    });

  const occurrenceWeeks = async () =>
    new Set(
      (
        await world.read((tx) =>
          tx.select({ periodStart: taskOccurrences.periodStart }).from(taskOccurrences),
        )
      ).map((row) => row.periodStart),
    );

  const alerts = () =>
    world.read((tx) =>
      tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.userId, world.userId), eq(notifications.severity, 'alert'))),
    );

  it('promotes a backlogged task once the horizon has moved over it', async () => {
    const taskId = await seedTask(world, 'Later');
    await world.run({ type: 'MoveToBacklog', params: { taskId } });

    // Parked at the end of the fortnight, so nothing places it today.
    expect(await world.cachedPlacements()).toEqual([]);

    // A fortnight on, that same floor is inside the horizon. Promotion needs
    // no un-parking — the floor does the right thing by construction, which is
    // why the job is a re-derive rather than a special case.
    await refreshAt('2026-04-06T08:00:00Z');

    const placements = await world.cachedPlacements();
    expect(placements).toHaveLength(1);
    expect(placements[0]!.interval.start).toBeGreaterThanOrEqual(toInstant('2026-04-06T00:00:00Z'));
  });

  it('spawns the demand a period that has begun needs', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Exercise',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
        recurrence: { period: 'week', count: 1 },
      },
    } as never);

    expect(await occurrenceWeeks()).toEqual(new Set(['2026-03-23', '2026-03-30']));

    // A fortnight later the horizon covers two different weeks, and nobody has
    // issued a command in between. Without the job these would never exist.
    await refreshAt('2026-04-06T08:00:00Z');

    const after = await occurrenceWeeks();
    expect(after.has('2026-04-06')).toBe(true);
    expect(after.has('2026-04-13')).toBe(true);
  });

  it('refreshes the signals, not only the schedule', async () => {
    await seedTask(world, 'Impossible', {
      estimatedDurationMin: 600,
      dueDate: { date: '2026-03-24T08:00:00Z', kind: 'hard' },
    });
    expect((await alerts()).length).toBeGreaterThan(0);

    // Cleared behind the job's back, so what comes next can only have been
    // produced by the job itself.
    await world.read((tx) => tx.delete(notifications));
    expect(await alerts()).toEqual([]);

    await refreshAt('2026-03-23T08:00:00Z');

    // §11's signals follow from a solve, and until M15 a solve only happened
    // when a command arrived. A deadline that passes while nobody is looking
    // is exactly the case a job exists for.
    expect((await alerts()).length).toBeGreaterThan(0);
  });

  it('is safe to run twice, which is what makes at-least-once acceptable', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Exercise',
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
        recurrence: { period: 'week', count: 2 },
      },
    } as never);

    await refreshAt('2026-04-06T08:00:00Z');
    const occurrencesAfterOne = (await world.read((tx) => tx.select().from(taskOccurrences)))
      .length;
    const placementsAfterOne = (await world.cachedPlacements()).length;

    // A queue cannot promise exactly-once across a process boundary, so the
    // work is made safe to repeat rather than guarded against repeating.
    // Nothing here holds a lock or writes a marker: demand tops up to a target,
    // placements are keyed by occurrence, signals replace their set.
    await refreshAt('2026-04-06T08:00:00Z');
    await refreshAt('2026-04-06T08:00:00Z');

    expect((await world.read((tx) => tx.select().from(taskOccurrences))).length).toBe(
      occurrencesAfterOne,
    );
    expect((await world.cachedPlacements()).length).toBe(placementsAfterOne);
  });

  it('writes nothing to the command log', async () => {
    await seedTask(world, 'Anything');
    const logged = () => world.read((tx) => tx.select({ id: commands.id }).from(commands));
    const before = (await logged()).length;

    await refreshAt('2026-04-06T08:00:00Z');

    // A job is not a command (§12). It took no decision, so there is nothing
    // for undo to reverse — and an entry for it would make the history claim
    // somebody did something. What it produced follows from source state and
    // the passage of time, and putting that back would mean putting time back.
    expect((await logged()).length).toBe(before);
  });

  it('does nothing for a calendar that has gone', async () => {
    // A job enqueued a minute ago is allowed to be about something that has
    // since been deleted. Not an error, and not a crashed worker.
    await expect(
      refreshCalendar({
        db: world.db,
        tenantId: world.tenantId,
        userId: world.userId,
        calendarId: '01a05000-0000-7000-8000-000000000000',
        now: toInstant('2026-04-06T08:00:00Z'),
      }),
    ).resolves.toBeUndefined();
  });
});
