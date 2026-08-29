import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_TUNING,
  validateSchedule,
  type Placement,
  type TuningConfig,
  type ValidationResult,
} from '@ambitime/scheduler';
import { newCommand, type CommandDraft, type CreateTaskParams } from '@ambitime/shared';
import { applyCommand, type CommandOutcome } from '../../src/commands/index.js';
import { withSystemPrivileges, withTenantContext } from '../../src/db/context.js';
import {
  isoText,
  loadScheduleContext,
  toInstant,
  toInstantCeil,
} from '../../src/schedule/index.js';
import {
  availabilityWindows,
  calendars,
  categories,
  placements,
  taskOccurrences,
  tasks,
  tenants,
} from '../../src/db/schema/index.js';
import { registerUser } from '../../src/identity/register-user.js';
import { addMember } from './fixtures.js';
import type { Database, DatabaseHandle, Transaction } from '../../src/db/client.js';
import type { Task } from '../../src/db/schema/index.js';

/**
 * The test harness the plan asks M6 for: a tenant context, injected.
 *
 * Commands run through the real pipeline against a real Postgres, because
 * everything M6 is actually claiming — that the write path is transactional,
 * that RLS scopes it, that the cache is recomputed rather than patched — is a
 * claim about the database. A mocked one would assert nothing.
 *
 * The world is a single user, in a single tenant, with one calendar in
 * `Europe/Berlin` and a work category available on weekdays. Berlin rather than
 * UTC on purpose: local week boundaries and wall-clock windows are where the
 * off-by-one-hour mistakes live, and a UTC-only fixture would never find them.
 */

/** Monday 2026-03-23, 09:00 Berlin (CET, UTC+1). The start of a working week. */
export const MONDAY_0900 = '2026-03-23T08:00:00Z';

export const TIME_ZONE = 'Europe/Berlin';

export interface World {
  db: Database;
  tenantId: string;
  userId: string;
  calendarId: string;
  categoryId: string;
  /** Applies a command as the world's user, at `MONDAY_0900` unless told otherwise. */
  run: (draft: WorldCommand, options?: RunOptions) => Promise<CommandOutcome>;
  /** The placements the last derive actually wrote, read back out of the cache. */
  cachedPlacements: () => Promise<Placement[]>;
  read: <T>(callback: (tx: Transaction) => Promise<T>) => Promise<T>;
}

/** A draft with the actor and tenant already known. */
export type WorldCommand = Omit<CommandDraft, 'actor' | 'tenantId'>;

export interface RunOptions {
  /** ISO instant the command is issued at; also the `now` it derives against. */
  at?: string;
  config?: TuningConfig;
  id?: string;
}

export interface WorldOptions {
  /** Weekday availability for the work category, in local minutes. */
  window?: { startMin: number; endMin: number; weekdays?: number[] };
  defaultCooldownMin?: number;
}

export async function createWorld(
  handle: DatabaseHandle,
  options: WorldOptions = {},
): Promise<World> {
  const { db } = handle;
  const user = await registerUser(db, { email: `owner-${Date.now()}@example.test` });
  const tenantId = await createTenant(db, 'Acme');
  await addMember(db, tenantId, user.userId, 'owner');

  const { calendarId, categoryId } = await withSystemPrivileges(db, async (tx) => {
    const [calendar] = await tx
      .insert(calendars)
      .values({ tenantId, ownerId: user.userId, name: 'Primary', timezone: TIME_ZONE })
      .returning({ id: calendars.id });
    const [category] = await tx
      .insert(categories)
      .values({
        tenantId,
        name: 'Work',
        defaultCooldownMin: options.defaultCooldownMin ?? 0,
      })
      .returning({ id: categories.id });

    if (!calendar || !category) throw new Error('Failed to build the test world');

    const window = options.window ?? { startMin: 9 * 60, endMin: 17 * 60 };
    await tx.insert(availabilityWindows).values(
      (window.weekdays ?? [1, 2, 3, 4, 5]).map((weekday) => ({
        tenantId,
        calendarId: calendar.id,
        categoryId: category.id,
        weekday,
        startMin: window.startMin,
        endMin: window.endMin,
      })),
    );

    return { calendarId: calendar.id, categoryId: category.id };
  });

  return {
    db,
    tenantId,
    userId: user.userId,
    calendarId,
    categoryId,

    run: (draft, runOptions = {}) =>
      applyCommand(
        db,
        newCommand({ ...draft, actor: user.userId, tenantId } as CommandDraft, {
          issuedAt: runOptions.at ?? MONDAY_0900,
          ...(runOptions.id === undefined ? {} : { id: runOptions.id }),
        }),
        runOptions.config === undefined ? {} : { config: runOptions.config },
      ),

    cachedPlacements: () =>
      withTenantContext(db, { userId: user.userId, tenantId }, (tx) =>
        readCachedPlacements(tx, calendarId),
      ),

    read: (callback) => withTenantContext(db, { userId: user.userId, tenantId }, callback),
  };
}

async function createTenant(db: Database, name: string): Promise<string> {
  return withSystemPrivileges(db, async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ name }).returning({ id: tenants.id });
    if (!tenant) throw new Error('Failed to create tenant');
    return tenant.id;
  });
}

/**
 * Creates a task through the real command path and hands back its id.
 *
 * Nearly every test needs one, and none of them should be reaching into the
 * tables to insert it: a task that arrived any way other than through a command
 * is a task the write path never saw (spec §3.2).
 */
export async function seedTask(
  world: World,
  title: string,
  params: Partial<CreateTaskParams> = {},
  options: RunOptions = {},
): Promise<string> {
  await world.run(
    {
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        ...params,
      },
    },
    options,
  );

  const [row] = await world.read((tx) =>
    tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, title)).limit(1),
  );

  if (!row) throw new Error(`Seeded task "${title}" was not found`);
  return row.id;
}

/** Where a task currently sits, according to the derived cache. */
export async function placementOf(world: World, taskId: string): Promise<Placement | undefined> {
  const [occurrence] = await world.read((tx) =>
    tx
      .select({ id: taskOccurrences.id })
      .from(taskOccurrences)
      .where(eq(taskOccurrences.taskId, taskId))
      .orderBy(taskOccurrences.id)
      .limit(1),
  );
  if (!occurrence) return undefined;

  const cached = await world.cachedPlacements();
  return cached.find((placement) => placement.occurrenceId === occurrence.id);
}

/** The task row itself, for the assertions that are about source state. */
export async function taskRow(world: World, taskId: string): Promise<Task> {
  const [row] = await world.read((tx) =>
    tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1),
  );
  if (!row) throw new Error(`Task ${taskId} no longer exists`);
  return row;
}

/** Whether a task row still exists at all — what undoing a create is about. */
export async function taskExists(world: World, taskId: string): Promise<boolean> {
  const [row] = await world.read((tx) =>
    tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
  );
  return row !== undefined;
}

/** The placement cache, in the engine's own representation. */
export async function readCachedPlacements(
  tx: Transaction,
  calendarId: string,
): Promise<Placement[]> {
  const rows = await tx
    .select({
      occurrenceId: placements.occurrenceId,
      startAt: isoText(sql`lower(${placements.during})`),
      endAt: isoText(sql`upper(${placements.during})`),
      cooldownMin: placements.cooldownMin,
    })
    .from(placements)
    .where(eq(placements.calendarId, calendarId))
    .orderBy(sql`lower(${placements.during})`, placements.occurrenceId);

  return rows.map((row) => ({
    occurrenceId: row.occurrenceId,
    interval: { start: toInstant(row.startAt), end: toInstantCeil(row.endAt) },
    cooldownMin: row.cooldownMin,
  }));
}

/**
 * Rebuilds the context the last derive ran against and checks the *persisted*
 * cache against it.
 *
 * Validating the solver's return value would only prove the solver right.
 * Reading the rows back proves the round trip: that the cache holds what was
 * derived, and that nothing was lost or reshaped by the range literal, the
 * timestamps or the cooldown column on the way through.
 */
export async function validatePersistedSchedule(
  world: World,
  at: string = MONDAY_0900,
  config: TuningConfig = DEFAULT_TUNING,
): Promise<ValidationResult> {
  return world.read(async (tx) => {
    const { context } = await loadScheduleContext({
      tx,
      calendarId: world.calendarId,
      now: toInstant(at),
      config,
    });

    return validateSchedule(context, await readCachedPlacements(tx, world.calendarId));
  });
}
