import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '../../src/commands/index.js';
import {
  availabilityWindows,
  calendars,
  calendarWindows,
  categories,
  weekTypeOverrides,
} from '../../src/db/schema/index.js';
import { registerUser } from '../../src/identity/register-user.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { addMember } from '../support/fixtures.js';
import { createWorld, MONDAY_0900, seedTask, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Configuration through the command layer (spec §4.3, §9.1).
 *
 * What is asserted here is mostly not "the row changed" — it is "the schedule
 * that follows changed". Configuration exists to constrain placement, so a
 * command that writes a perfect availability window the solver then ignores has
 * done nothing, and only a test that looks at the placements can tell.
 */
describe('calendar configuration', () => {
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

  describe('CreateCalendar', () => {
    it('creates one owned by the actor', async () => {
      const outcome = await world.run({
        type: 'CreateCalendar',
        params: { name: 'Side project', timezone: 'Europe/Lisbon' },
      });

      const [row] = await world.read((tx) =>
        tx.select().from(calendars).where(eq(calendars.name, 'Side project')),
      );

      expect(row?.ownerId).toBe(world.userId);
      expect(row?.timezone).toBe('Europe/Lisbon');
      expect(row?.visibilityScope).toBe('private');
      // Derived immediately, and empty: the cache is a total function of
      // source, including when the source is nothing at all (§3.4).
      expect(outcome.schedules).toHaveLength(1);
      expect(outcome.schedules[0]?.placements).toEqual([]);
    });

    it('refuses a name the actor is already using', async () => {
      await expect(
        world.run({
          type: 'CreateCalendar',
          params: { name: 'Primary', timezone: 'Europe/Berlin' },
        }),
      ).rejects.toThrow(PreconditionFailedError);
    });
  });

  describe('ConfigureCalendar', () => {
    it('moves every placement when the zone changes', async () => {
      // The window is 09:00–17:00 *local*, so re-homing the calendar in Lisbon
      // (UTC+0 in March, against Berlin's UTC+1) moves the working day an hour
      // later in UTC without the window itself changing at all (§5.1).
      await seedTask(world, 'Report');
      const before = await world.cachedPlacements();

      await world.run({
        type: 'ConfigureCalendar',
        params: { calendarId: world.calendarId, patch: { timezone: 'Europe/Lisbon' } },
      });

      const after = await world.cachedPlacements();
      expect(after[0]?.interval.start).toBe((before[0]?.interval.start ?? 0) + 60);
    });

    it('refuses to reconfigure a calendar the actor does not own', async () => {
      // RLS puts them in the same tenant; §4.3 still says the calendar is one
      // person's, and §10.2 asks for the predicate on top of the isolation.
      const other = await registerUser(world.db, { email: `other-${Date.now()}@example.test` });
      await addMember(world.db, world.tenantId, other.userId, 'member');

      const outcome = world.run({
        type: 'ConfigureCalendar',
        params: { calendarId: world.calendarId, patch: { name: 'Mine now' } },
      });

      // The actor here *is* the owner, so this one succeeds …
      await expect(outcome).resolves.toBeDefined();

      // … and the same command from the colleague does not.
      await expect(
        world.runAs(other.userId, {
          type: 'ConfigureCalendar',
          params: { calendarId: world.calendarId, patch: { name: 'Mine now, really' } },
        }),
      ).rejects.toThrow(PreconditionFailedError);
    });
  });

  describe('SetCalendarWindows', () => {
    it('clips placement to the working window (spec §9.1)', async () => {
      // The category is available 09:00–17:00. A working window of 13:00–17:00
      // has to win, or the setting means nothing.
      await world.run({
        type: 'SetCalendarWindows',
        params: {
          calendarId: world.calendarId,
          kind: 'working',
          windows: [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            startMin: 13 * 60,
            endMin: 17 * 60,
          })),
        },
      });

      await seedTask(world, 'Afternoon only');

      const [placement] = await world.cachedPlacements();
      // 13:00 Berlin on Monday 2026-03-23 is 12:00Z.
      expect(placement?.interval.start).toBe(toInstant('2026-03-23T12:00:00Z'));
    });

    it('replaces the set rather than adding to it', async () => {
      const set = (startMin: number) => ({
        type: 'SetCalendarWindows' as const,
        params: {
          calendarId: world.calendarId,
          kind: 'working' as const,
          windows: [{ weekday: 1, startMin, endMin: startMin + 60 }],
        },
      });

      await world.run(set(9 * 60));
      await world.run(set(11 * 60));

      const rows = await world.read((tx) =>
        tx.select().from(calendarWindows).where(eq(calendarWindows.calendarId, world.calendarId)),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.startMin).toBe(11 * 60);
    });

    it('does not re-derive for the shareable window', async () => {
      // §9.2's shareable window governs what *other users* see. This
      // calendar's own schedule cannot have changed, and saying it did would
      // tell a user their day had been recalculated when it had not.
      const outcome = await world.run({
        type: 'SetCalendarWindows',
        params: {
          calendarId: world.calendarId,
          kind: 'shareable',
          windows: [{ weekday: 1, startMin: 9 * 60, endMin: 17 * 60 }],
        },
      });

      expect(outcome.schedules).toEqual([]);
    });

    it('stores the two kinds side by side', async () => {
      await world.run({
        type: 'SetCalendarWindows',
        params: {
          calendarId: world.calendarId,
          kind: 'working',
          windows: [{ weekday: 1, startMin: 9 * 60, endMin: 17 * 60 }],
        },
      });
      await world.run({
        type: 'SetCalendarWindows',
        params: {
          calendarId: world.calendarId,
          kind: 'shareable',
          windows: [{ weekday: 1, startMin: 8 * 60, endMin: 20 * 60 }],
        },
      });

      const rows = await world.read((tx) =>
        tx.select().from(calendarWindows).where(eq(calendarWindows.calendarId, world.calendarId)),
      );

      // Setting one must not clear the other; they share a table, not a set.
      expect(rows.map((row) => row.kind).sort()).toEqual(['shareable', 'working']);
    });
  });

  describe('categories', () => {
    it('creates one without deriving anything', async () => {
      const outcome = await world.run({
        type: 'CreateCategory',
        params: { name: 'Exercise', defaultCooldownMin: 15 },
      });

      // No windows, no tasks — no calendar's schedule can have moved.
      expect(outcome.schedules).toEqual([]);

      const [row] = await world.read((tx) =>
        tx.select().from(categories).where(eq(categories.name, 'Exercise')),
      );
      expect(row?.defaultCooldownMin).toBe(15);
    });

    it('refuses a duplicate name in the tenant', async () => {
      await expect(world.run({ type: 'CreateCategory', params: { name: 'Work' } })).rejects.toThrow(
        PreconditionFailedError,
      );
    });

    it('re-derives for a cooldown change but not for a rename', async () => {
      await seedTask(world, 'Report');

      const renamed = await world.run({
        type: 'EditCategory',
        params: { categoryId: world.categoryId, patch: { name: 'Deep work' } },
      });
      expect(renamed.schedules).toEqual([]);

      const cooled = await world.run({
        type: 'EditCategory',
        params: { categoryId: world.categoryId, patch: { defaultCooldownMin: 30 } },
      });
      expect(cooled.schedules.map((schedule) => schedule.calendarId)).toEqual([world.calendarId]);

      const [placement] = await world.cachedPlacements();
      expect(placement?.cooldownMin).toBe(30);
    });

    it('refuses to delete a category tasks still use', async () => {
      await seedTask(world, 'Report');

      // The FK would `SET NULL` and leave a task matching no window at all —
      // silently unschedulable is worse than refused (§6.2 rule 1).
      await expect(
        world.run({ type: 'DeleteCategory', params: { categoryId: world.categoryId } }),
      ).rejects.toThrow(PreconditionFailedError);
    });

    it('takes its availability windows with it when deleted', async () => {
      const outcome = await world.run({
        type: 'DeleteCategory',
        params: { categoryId: world.categoryId },
      });

      const windows = await world.read((tx) =>
        tx
          .select()
          .from(availabilityWindows)
          .where(eq(availabilityWindows.categoryId, world.categoryId)),
      );

      expect(windows).toEqual([]);
      // The calendar had windows for it, so its schedule is now different.
      expect(outcome.schedules.map((schedule) => schedule.calendarId)).toEqual([world.calendarId]);
    });
  });

  describe('SetAvailabilityWindows', () => {
    it('replaces the default set for one category', async () => {
      await world.run({
        type: 'SetAvailabilityWindows',
        params: {
          calendarId: world.calendarId,
          categoryId: world.categoryId,
          windows: [{ weekday: 1, startMin: 14 * 60, endMin: 16 * 60, focusLevel: 4 }],
        },
      });

      await seedTask(world, 'Deep work');

      const [placement] = await world.cachedPlacements();
      // 14:00 Berlin on Monday 2026-03-23 is 13:00Z.
      expect(placement?.interval.start).toBe(toInstant('2026-03-23T13:00:00Z'));

      const rows = await world.read((tx) =>
        tx
          .select()
          .from(availabilityWindows)
          .where(eq(availabilityWindows.calendarId, world.calendarId)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.focusLevel).toBe(4);
    });

    it('treats an empty set as "not available here"', async () => {
      await seedTask(world, 'Report');
      expect(await world.cachedPlacements()).toHaveLength(1);

      await world.run({
        type: 'SetAvailabilityWindows',
        params: { calendarId: world.calendarId, categoryId: world.categoryId, windows: [] },
      });

      // An empty array is an instruction, not a no-op: the task is now
      // unplaceable and falls out of the horizon entirely.
      expect(await world.cachedPlacements()).toEqual([]);
    });

    it('addresses an override’s set separately from the default one', async () => {
      const created = await world.run({
        type: 'CreateWeekTypeOverride',
        params: {
          calendarId: world.calendarId,
          name: 'Conference',
          startDate: '2026-03-23',
          endDate: '2026-03-28',
        },
      });

      const overrideId = await onlyOverrideId(world);
      expect(created.schedules).toHaveLength(1);

      await world.run({
        type: 'SetAvailabilityWindows',
        params: {
          calendarId: world.calendarId,
          categoryId: world.categoryId,
          weekTypeOverrideId: overrideId,
          windows: [{ weekday: 1, startMin: 18 * 60, endMin: 20 * 60 }],
        },
      });

      const defaults = await world.read((tx) =>
        tx
          .select()
          .from(availabilityWindows)
          .where(
            and(
              eq(availabilityWindows.calendarId, world.calendarId),
              isNull(availabilityWindows.weekTypeOverrideId),
            ),
          ),
      );

      // Writing the override's set must leave the default set untouched: they
      // are different addresses, not different versions of one thing.
      expect(defaults).toHaveLength(5);

      await seedTask(world, 'Conference week');
      const [placement] = await world.cachedPlacements();
      // 18:00 Berlin on the Monday inside the override is 17:00Z.
      expect(placement?.interval.start).toBe(toInstant('2026-03-23T17:00:00Z'));
    });
  });

  describe('week-type overrides', () => {
    it('empties its range until it is given windows of its own', async () => {
      await world.run({
        type: 'CreateWeekTypeOverride',
        params: {
          calendarId: world.calendarId,
          name: 'Holiday',
          startDate: '2026-03-23',
          endDate: '2026-03-28',
        },
      });

      await seedTask(world, 'Report');

      // An override *replaces* the default set (§4.3); with no windows of its
      // own it replaces it with nothing, and the week is not workable. The task
      // lands on the first working morning past the override, not nowhere —
      // asserted as an equality so an empty schedule cannot pass vacuously.
      const [placement] = await world.cachedPlacements();
      expect(placement?.interval.start).toBe(toInstant('2026-03-30T07:00:00Z'));
    });

    it('refuses an edit that would end it before it starts', async () => {
      await world.run({
        type: 'CreateWeekTypeOverride',
        params: {
          calendarId: world.calendarId,
          name: 'Holiday',
          startDate: '2026-03-23',
          endDate: '2026-03-28',
        },
      });

      // Only one date moves, so the ordering can only be checked against the
      // merged result — which is the handler's job, not the schema's.
      await expect(
        world.run({
          type: 'EditWeekTypeOverride',
          params: {
            weekTypeOverrideId: await onlyOverrideId(world),
            patch: { startDate: '2026-03-30' },
          },
        }),
      ).rejects.toThrow(PreconditionFailedError);
    });

    it('takes its own availability windows with it when deleted', async () => {
      await world.run({
        type: 'CreateWeekTypeOverride',
        params: {
          calendarId: world.calendarId,
          name: 'Holiday',
          startDate: '2026-03-23',
          endDate: '2026-03-28',
        },
      });
      const overrideId = await onlyOverrideId(world);

      await world.run({
        type: 'SetAvailabilityWindows',
        params: {
          calendarId: world.calendarId,
          categoryId: world.categoryId,
          weekTypeOverrideId: overrideId,
          windows: [{ weekday: 1, startMin: 18 * 60, endMin: 20 * 60 }],
        },
      });

      await world.run({
        type: 'DeleteWeekTypeOverride',
        params: { weekTypeOverrideId: overrideId },
      });

      const orphans = await world.read((tx) =>
        tx
          .select()
          .from(availabilityWindows)
          .where(eq(availabilityWindows.weekTypeOverrideId, overrideId)),
      );
      expect(orphans).toEqual([]);

      // With the override gone, the default set governs the week again.
      await seedTask(world, 'Report');
      const [placement] = await world.cachedPlacements();
      expect(placement?.interval.start).toBe(toInstant(MONDAY_0900));
    });
  });

  /**
   * Spec §12. Configuration joined the journalled tables for one reason: a
   * mis-set window reflows a fortnight, and a person who did that by accident
   * wants one gesture to put it back. These are that gesture.
   */
  describe('undo', () => {
    it('puts a replaced availability set back', async () => {
      await seedTask(world, 'Report');
      const before = await world.cachedPlacements();

      await world.run({
        type: 'SetAvailabilityWindows',
        params: {
          calendarId: world.calendarId,
          categoryId: world.categoryId,
          windows: [{ weekday: 1, startMin: 14 * 60, endMin: 16 * 60 }],
        },
      });
      expect((await world.cachedPlacements())[0]?.interval.start).not.toBe(
        before[0]?.interval.start,
      );

      await world.run({ type: 'Undo', params: {} });

      const restored = await world.read((tx) =>
        tx
          .select()
          .from(availabilityWindows)
          .where(eq(availabilityWindows.calendarId, world.calendarId)),
      );

      // Five weekday rules back, and the schedule that followed from them.
      expect(restored).toHaveLength(5);
      expect((await world.cachedPlacements())[0]?.interval.start).toBe(before[0]?.interval.start);
    });

    it('restores a deleted category together with its windows', async () => {
      await world.run({ type: 'DeleteCategory', params: { categoryId: world.categoryId } });
      await world.run({ type: 'Undo', params: {} });

      const [category] = await world.read((tx) =>
        tx.select().from(categories).where(eq(categories.id, world.categoryId)),
      );
      const windows = await world.read((tx) =>
        tx
          .select()
          .from(availabilityWindows)
          .where(eq(availabilityWindows.categoryId, world.categoryId)),
      );

      // The cascade is performed in the handler precisely so this works: a
      // database `ON DELETE CASCADE` happens where the journal cannot see it,
      // and undo would have restored a category with no availability at all.
      expect(category?.name).toBe('Work');
      expect(windows).toHaveLength(5);
    });

    it('puts a working window back, and the day it moved', async () => {
      await seedTask(world, 'Report');
      const before = await world.cachedPlacements();

      await world.run({
        type: 'SetCalendarWindows',
        params: {
          calendarId: world.calendarId,
          kind: 'working',
          windows: [{ weekday: 1, startMin: 13 * 60, endMin: 17 * 60 }],
        },
      });
      expect((await world.cachedPlacements())[0]?.interval.start).toBe(
        toInstant('2026-03-23T12:00:00Z'),
      );

      await world.run({ type: 'Undo', params: {} });

      const rows = await world.read((tx) =>
        tx.select().from(calendarWindows).where(eq(calendarWindows.calendarId, world.calendarId)),
      );

      // Back to no working window at all, which means unrestricted — not an
      // empty one, which would mean nothing may be placed (§9.1).
      expect(rows).toEqual([]);
      expect((await world.cachedPlacements())[0]?.interval.start).toBe(before[0]?.interval.start);
    });
  });
});

async function onlyOverrideId(world: World): Promise<string> {
  const rows = await world.read((tx) =>
    tx
      .select({ id: weekTypeOverrides.id })
      .from(weekTypeOverrides)
      .where(eq(weekTypeOverrides.calendarId, world.calendarId)),
  );

  const id = rows[0]?.id;
  if (id === undefined) throw new Error('Expected exactly one week-type override');
  return id;
}
