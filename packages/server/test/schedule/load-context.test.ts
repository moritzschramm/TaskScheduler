import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '@ambitime/scheduler';
import { withSystemPrivileges } from '../../src/db/context.js';
import {
  availabilityWindows,
  sequences,
  tasks,
  weekTypeOverrides,
} from '../../src/db/schema/index.js';
import { CalendarNotFoundError, loadScheduleContext, toInstant } from '../../src/schedule/index.js';
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
 * The impure half of spec §3.3: turning a calendar's rows into the plain data
 * the engine takes.
 *
 * Most of what can go wrong here is silent. An inherited cooldown resolved to
 * zero, a week-type override that adds instead of replaces, a sequence whose
 * membership was dropped on the way through — none of these throw. They just
 * produce a schedule that is subtly not the one the data describes.
 */
describe('what reaches the engine', () => {
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
    world = await createWorld(handle, { defaultCooldownMin: 30 });
  });

  const create = (title: string, params: Partial<CreateTaskParams> = {}) =>
    world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        ...params,
      },
    });

  const context = (at: string = MONDAY_0900) =>
    world.read(async (tx) =>
      loadScheduleContext({
        tx,
        calendarId: world.calendarId,
        now: toInstant(at),
        config: DEFAULT_TUNING,
      }),
    );

  it('resolves the cooldown from the category, and lets a task override it', async () => {
    await create('Inherits the default');
    await create('Overrides it', { cooldownOverrideMin: 5 });

    const { context: loaded } = await context();
    const cooldowns = loaded.schedulables.map((schedulable) => schedulable.cooldownMin);

    expect([...cooldowns].sort((a, b) => a - b)).toEqual([5, 30]);
  });

  it('resolves inherited properties down the tree', async () => {
    await create('Parent', { priority: 5, focusLevel: 4, estimatedDurationMin: undefined });
    const [parent] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Parent')).limit(1),
    );
    await create('Child', { parentId: parent!.id, categoryId: undefined });

    const { context: loaded } = await context();

    expect(loaded.schedulables).toHaveLength(1);
    expect(loaded.schedulables[0]).toMatchObject({
      priority: 5,
      focusLevel: 4,
      categoryId: world.categoryId,
    });
  });

  it('starts the placeable horizon at `now`, not at the start of the week', async () => {
    // Wednesday afternoon. Monday morning is still inside the hard horizon, and
    // §6.2 does not forbid placing there — but §7 assumes forward-only
    // scheduling throughout, and a task offered Monday 09:00 on Wednesday is
    // not a schedule.
    await create('Urgent');
    const { context: loaded } = await context('2026-03-25T13:00:00Z');

    expect(loaded.horizon.start).toBe(toInstant('2026-03-25T13:00:00Z'));
    expect(loaded.windows.every((window) => window.interval.start >= loaded.horizon.start)).toBe(
      true,
    );
  });

  it('lets a week-type override replace the default windows rather than add to them', async () => {
    await create('Conference week task');
    await withSystemPrivileges(world.db, async (tx) => {
      const [override] = await tx
        .insert(weekTypeOverrides)
        .values({
          tenantId: world.tenantId,
          calendarId: world.calendarId,
          name: 'Conference',
          startDate: '2026-03-23',
          endDate: '2026-03-25',
        })
        .returning({ id: weekTypeOverrides.id });

      // During the conference only Tuesday evening is available.
      await tx.insert(availabilityWindows).values({
        tenantId: world.tenantId,
        calendarId: world.calendarId,
        categoryId: world.categoryId,
        weekTypeOverrideId: override!.id,
        weekday: 2,
        startMin: 18 * 60,
        endMin: 20 * 60,
      });
    });

    const { context: loaded } = await context();
    const monday = loaded.windows.filter(
      (window) => window.interval.start < toInstant('2026-03-24T00:00:00Z'),
    );

    // Monday's default 09:00–17:00 window is gone, not supplemented.
    expect(monday).toHaveLength(0);
    expect(loaded.windows[0]!.interval.start).toBe(toInstant('2026-03-24T17:00:00Z'));
  });

  it('carries sequence membership through, so the block is placed as one', async () => {
    const sequenceId = await withSystemPrivileges(world.db, async (tx) => {
      const [row] = await tx
        .insert(sequences)
        .values({
          tenantId: world.tenantId,
          calendarId: world.calendarId,
          name: 'Gym trip',
          isOrdered: true,
        })
        .returning({ id: sequences.id });
      return row!.id;
    });

    await create('Warm up', { sequenceId, sequencePosition: 1, estimatedDurationMin: 30 });
    await create('Lift', { sequenceId, sequencePosition: 2, estimatedDurationMin: 60 });
    const outcome = await create('Shower', {
      sequenceId,
      sequencePosition: 3,
      estimatedDurationMin: 15,
    });

    const placed = outcome.schedules[0]!.placements;
    expect(placed).toHaveLength(3);

    // Members abut, each gap being exactly the previous member's 30-minute
    // category cooldown (§6.2 rules 3 and 5).
    for (let index = 1; index < placed.length; index += 1) {
      expect(placed[index]!.interval.start).toBe(
        placed[index - 1]!.interval.end + placed[index - 1]!.cooldownMin,
      );
    }
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('refuses a calendar that is not visible in this context', async () => {
    const other = await createWorld(handle);

    await expect(
      world.read((tx) =>
        loadScheduleContext({
          tx,
          calendarId: other.calendarId,
          now: toInstant(MONDAY_0900),
          config: DEFAULT_TUNING,
        }),
      ),
    ).rejects.toBeInstanceOf(CalendarNotFoundError);
  });
});
