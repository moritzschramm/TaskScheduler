import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newCommand } from '@ambitime/shared';
import {
  applyCommand,
  CommandValidationError,
  OptimisticLockError,
  PreconditionFailedError,
} from '../../src/commands/index.js';
import { commands, placements, tasks } from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The apply pipeline (spec §7.1): validate, apply to source, re-derive,
 * persist the cache, append to the log, return the schedule.
 *
 * What is worth testing here is not any one command but the envelope around
 * all of them — that the steps happen in that order, in one transaction, and
 * that a command which fails any of them leaves nothing behind.
 */
describe('the single write path', () => {
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

  async function createTask(title: string, durationMin = 60): Promise<string> {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: durationMin,
      },
    });

    const [row] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, title)).limit(1),
    );
    if (!row) throw new Error(`Task ${title} was not created`);
    return row.id;
  }

  it('appends every applied command to the log, in order', async () => {
    await createTask('First');
    await createTask('Second');

    const log = await world.read((tx) =>
      tx
        .select({ seq: commands.seq, type: commands.type, actorId: commands.actorId })
        .from(commands)
        .orderBy(commands.seq),
    );

    expect(log.map((entry) => entry.type)).toEqual(['CreateTask', 'CreateTask']);
    expect(log[0]!.seq).toBeLessThan(log[1]!.seq);
    expect(log[0]!.actorId).toBe(world.userId);
  });

  it('leaves no log entry and no mutation when a command is rejected', async () => {
    await expect(
      world.run({
        type: 'EditTask',
        params: { taskId: '018f3a2b-0000-7000-8000-0000000000ff', patch: { title: 'Ghost' } },
      }),
    ).rejects.toThrow(/No task/);

    const log = await world.read((tx) => tx.select({ id: commands.id }).from(commands));
    expect(log).toHaveLength(0);
  });

  it('rolls the mutation back when a later step of the same command fails', async () => {
    const taskId = await createTask('Real');

    // The edit succeeds; appending the log entry does not, because the id is
    // already taken. Both must be undone together.
    const duplicateId = await world.read(async (tx) => {
      const [entry] = await tx.select({ id: commands.id }).from(commands).limit(1);
      return entry!.id;
    });

    await expect(
      world.run(
        { type: 'EditTask', params: { taskId, patch: { title: 'Renamed' } } },
        { id: duplicateId },
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    const [task] = await world.read((tx) =>
      tx.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
    );
    expect(task!.title).toBe('Real');
  });

  it('recomputes the placement cache rather than editing it', async () => {
    const taskId = await createTask('Recomputed');
    const before = await world.read((tx) =>
      tx
        .select({ id: placements.id })
        .from(placements)
        .where(eq(placements.calendarId, world.calendarId)),
    );
    expect(before).toHaveLength(1);

    await world.run({ type: 'EditTask', params: { taskId, patch: { title: 'Still one' } } });

    const after = await world.read((tx) =>
      tx
        .select({ id: placements.id })
        .from(placements)
        .where(eq(placements.calendarId, world.calendarId)),
    );
    // Same schedule, but a *new* row: the cache is derived state, replaced
    // wholesale on every command (spec §3.4).
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before[0]!.id);
  });
});

describe('optimistic locking (spec §5.4)', () => {
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

  async function seedTask(): Promise<{ id: string; version: number }> {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Locked',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    });

    const [row] = await world.read((tx) =>
      tx.select({ id: tasks.id, version: tasks.version }).from(tasks).limit(1),
    );
    return row!;
  }

  it('accepts a command carrying the current version', async () => {
    const task = await seedTask();

    await expect(
      world.run({
        type: 'EditTask',
        params: { taskId: task.id, patch: { priority: 3 } },
        expectedVersion: task.version,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a command carrying a stale version', async () => {
    const task = await seedTask();
    await world.run({ type: 'EditTask', params: { taskId: task.id, patch: { priority: 3 } } });

    const error = await world
      .run({
        type: 'EditTask',
        params: { taskId: task.id, patch: { priority: 4 } },
        expectedVersion: task.version,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OptimisticLockError);
    expect((error as OptimisticLockError).expectedVersion).toBe(task.version);
    expect((error as OptimisticLockError).actualVersion).toBeGreaterThan(task.version);
  });

  it('applies without a version, because the envelope makes it optional', async () => {
    const task = await seedTask();

    await expect(
      world.run({ type: 'EditTask', params: { taskId: task.id, patch: { priority: 5 } } }),
    ).resolves.toBeDefined();
  });

  it('refuses a version on a command that names no single entity', async () => {
    // Accepting it and doing nothing with it would leave the caller believing
    // they were protected against a concurrent edit.
    await expect(
      world.run({
        type: 'PostponeRestOfDay',
        params: { calendarId: world.calendarId, date: '2026-03-23' },
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(CommandValidationError);
  });
});

describe('command validation', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('rejects a malformed command before it reaches a transaction', async () => {
    await expect(
      applyCommand(
        handle.db,
        newCommand({
          type: 'CreateTask',
          actor: '018f3a2b-0000-7000-8000-000000000001',
          tenantId: '018f3a2b-0000-7000-8000-000000000002',
          // A task with no title is not something the vocabulary allows.
          params: { calendarId: '018f3a2b-0000-7000-8000-000000000003', title: '' },
        }),
        {},
      ),
    ).rejects.toBeInstanceOf(CommandValidationError);
  });

  it('does not leak whether an entity exists in another tenant', async () => {
    const world = await createWorld(handle);
    const other = await createWorld(handle);

    // `world`'s user acting on `other`'s calendar: RLS hides the row, and the
    // answer is the same one a nonexistent id gets.
    await expect(
      world.run({
        type: 'CreateTask',
        params: { calendarId: other.calendarId, title: 'Trespass' },
      }),
    ).rejects.toThrow(/No calendar/);
  });
});
