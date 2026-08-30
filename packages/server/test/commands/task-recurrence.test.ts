import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { taskOccurrences } from '../../src/db/schema/index.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Task recurrence — the per-period demand generator of spec §8.2.
 *
 * A recurring task is a **demand rule**, not a datetime rule: "exercise 3× per
 * week" says how much a period should hold and nothing about when. So what is
 * asserted here is how many occurrences exist and which period each belongs to
 * — never a time. Where they land is the scheduler's business, and asserting on
 * it would be testing the solver twice.
 *
 * The other mechanism, an appointment's RRULE expansion (§8.1), shares no code
 * with this and is not exercised here. That they stay apart is the point.
 */
describe('the per-period demand generator', () => {
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

  const recur = (
    title: string,
    recurrence: { period: 'day' | 'week' | 'month'; count: number; missedPolicy?: string },
    extra: Record<string, unknown> = {},
  ) =>
    world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        recurrence,
        ...extra,
      },
    } as never);

  const occurrences = (taskId?: string) =>
    world.read((tx) =>
      tx
        .select({
          id: taskOccurrences.id,
          periodStart: taskOccurrences.periodStart,
          periodEnd: taskOccurrences.periodEnd,
          status: taskOccurrences.status,
          rolledOverFromId: taskOccurrences.rolledOverFromId,
        })
        .from(taskOccurrences)
        .where(taskId === undefined ? undefined : eq(taskOccurrences.taskId, taskId))
        .orderBy(asc(taskOccurrences.periodStart), asc(taskOccurrences.id)),
    );

  const taskIdOf = (result: Awaited<ReturnType<typeof recur>>) =>
    result.created.find((row) => row.entity === 'task')!.id;

  it('spawns one occurrence per period, per count', async () => {
    const created = await recur('Exercise', { period: 'week', count: 3 });
    const rows = await occurrences(taskIdOf(created));

    // The horizon is a fortnight of local weeks, so two periods × three.
    const weeks = new Set(rows.map((row) => row.periodStart));
    expect(weeks).toEqual(new Set(['2026-03-23', '2026-03-30']));
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
  });

  it('gives a recurring task no period-less occurrence of its own', async () => {
    const created = await recur('Exercise', { period: 'week', count: 1 });

    // A non-recurring task gets exactly one occurrence with no period. A
    // recurring one must not also carry that: it would be a unit of work
    // nobody asked for, with no period to bound where it went.
    const rows = await occurrences(taskIdOf(created));
    expect(rows.every((row) => row.periodStart !== null)).toBe(true);
  });

  it('is idempotent: re-running tops up rather than piling up', async () => {
    const created = await recur('Exercise', { period: 'week', count: 2 });
    const taskId = taskIdOf(created);
    const before = await occurrences(taskId);

    // Every command re-runs the generator. Spawning to a target rather than on
    // a schedule is what keeps that safe.
    for (let index = 0; index < 3; index += 1) {
      await world.run({
        type: 'EditTask',
        params: { taskId, patch: { notes: `pass ${index}` } },
      });
    }

    expect(await occurrences(taskId)).toHaveLength(before.length);
  });

  it('counts a completed occurrence as demand already met', async () => {
    const created = await recur('Exercise', { period: 'week', count: 2 });
    const taskId = taskIdOf(created);

    const [first] = await occurrences(taskId);
    await world.read(async () => undefined);
    await world.run({ type: 'CompleteTask', params: { taskId } });

    const rows = await occurrences(taskId);
    const thisWeek = rows.filter((row) => row.periodStart === first!.periodStart);

    // Still two for the week: one done, one to go. Topping back up to two
    // *pending* would make the week's demand grow every time it was met.
    expect(thisWeek).toHaveLength(2);
    expect(thisWeek.filter((row) => row.status === 'completed')).toHaveLength(1);
  });

  it('places each occurrence inside its own period', async () => {
    const created = await recur('Exercise', { period: 'week', count: 1 });
    const taskId = taskIdOf(created);
    expect(taskId).toBeDefined();

    const placements = await world.cachedPlacements();
    expect(placements.length).toBeGreaterThan(0);

    // §8.2 says "placed flexibly within its period" — flexibly, but within.
    // The bound is expressed as a floor and a soft due date, so the engine
    // needs no new concept and the property suite is untouched.
    // The first week's occurrence lands in the first week and the second
    // week's in the second — one each side of the boundary, rather than both
    // crowding into whichever week the solver reached first.
    const secondWeek = toInstant('2026-03-29T22:00:00Z');
    expect(placements.filter((placement) => placement.interval.start < secondWeek)).toHaveLength(1);
    expect(placements.filter((placement) => placement.interval.start >= secondWeek)).toHaveLength(
      1,
    );
  });

  describe('the missed-instance policy (§8.2)', () => {
    it('rolls a missed period forward as debt, by default', async () => {
      // Created a week earlier, so by `now` its first week has ended unmet.
      const created = await recur('Invoice', { period: 'week', count: 1 }, {});
      const taskId = taskIdOf(created);

      // Move time on a week: the command re-runs the generator at the later
      // `now`, which is when a period that has ended becomes a missed one.
      await world.run(
        { type: 'EditTask', params: { taskId, patch: { notes: 'next week' } } },
        { at: '2026-03-30T08:00:00Z' },
      );

      const rows = await occurrences(taskId);
      const expired = rows.filter((row) => row.status === 'expired');
      const carried = rows.filter((row) => row.rolledOverFromId !== null);

      // The debt moves rather than staying put: an occurrence still pointing at
      // last week would be demand the solver had to place in a week that has
      // gone.
      expect(expired.length).toBeGreaterThan(0);
      expect(carried.length).toBe(expired.length);
      expect(carried.every((row) => row.status === 'pending')).toBe(true);
    });

    it('drops a missed period when the task says to expire it', async () => {
      const created = await recur('Workout', {
        period: 'week',
        count: 1,
        missedPolicy: 'expire',
      });
      const taskId = taskIdOf(created);

      await world.run(
        { type: 'EditTask', params: { taskId, patch: { notes: 'next week' } } },
        { at: '2026-03-30T08:00:00Z' },
      );

      const rows = await occurrences(taskId);

      // §8.2's own example: a missed workout should not distort the next
      // period. Nothing carries the debt forward.
      expect(rows.filter((row) => row.status === 'expired').length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.rolledOverFromId !== null)).toEqual([]);
    });
  });

  it('stops generating when the rule is removed', async () => {
    const created = await recur('Exercise', { period: 'week', count: 2 });
    const taskId = taskIdOf(created);

    await world.run({ type: 'EditTask', params: { taskId, patch: { recurrence: null } } });
    const after = await occurrences(taskId);

    // The occurrences already spawned are demand that still exists; what stops
    // is the spawning. Deleting them would throw away work already planned.
    await world.run({ type: 'EditTask', params: { taskId, patch: { notes: 'again' } } });
    expect(await occurrences(taskId)).toHaveLength(after.length);
  });

  it('does not generate for a task that has become a parent', async () => {
    const created = await recur('Exercise', { period: 'week', count: 2 });
    const parentId = taskIdOf(created);

    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'A subtask',
        parentId,
        categoryId: world.categoryId,
        estimatedDurationMin: 30,
      },
    });

    // Only leaves are placed (§4.4), so only leaves are demand. The rule stays
    // on the row; it simply stops producing.
    const before = (await occurrences(parentId)).length;
    await world.run({ type: 'EditTask', params: { taskId: parentId, patch: { notes: 'x' } } });
    expect(await occurrences(parentId)).toHaveLength(before);
  });
});
