import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '../../src/commands/index.js';
import {
  appointments,
  availabilityWindows,
  categories,
  taskOccurrences,
  tasks,
} from '../../src/db/schema/index.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import {
  createWorld,
  MONDAY_0900,
  seedTask,
  validatePersistedSchedule,
  type World,
} from '../support/world.js';
import type { CreateTaskParams } from '@ambitime/shared';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Creating and editing tasks and appointments, end to end.
 *
 * The acceptance the plan asks for is deliberately indirect: not "the command
 * wrote the right row" but "the schedule that came out of it is valid". A
 * command that mutates source correctly and derives a schedule violating §6.2
 * has not done its job.
 */
describe('creating tasks', () => {
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

  it('yields a valid derived schedule', async () => {
    await create('Write the report');
    await create('Review the draft');
    const outcome = await create('Call the bank');

    expect(outcome.schedules[0]!.placements).toHaveLength(3);
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('places the first task at the start of the working window, not the week', async () => {
    // `now` is Monday 09:00 Berlin and the window opens at 09:00, so the
    // earliest legal slot is now — not Monday 00:00, which the horizon starts at.
    const outcome = await create('First thing');

    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(toInstant(MONDAY_0900));
  });

  it('gives every new task the occurrence that makes it demand', async () => {
    await create('Has an occurrence');

    const occurrences = await world.read((tx) =>
      tx.select({ id: taskOccurrences.id, status: taskOccurrences.status }).from(taskOccurrences),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.status).toBe('pending');
  });

  it('retires a task’s occurrence once it becomes a parent', async () => {
    await create('Project');
    const [parent] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Project')).limit(1),
    );

    const outcome = await create('Subtask', { parentId: parent!.id });

    // A branch is not a unit of work — its duration rolls up from its leaves
    // (§4.4) — so the parent must stop competing with its own child for time.
    const remaining = await world.read((tx) =>
      tx.select({ taskId: taskOccurrences.taskId }).from(taskOccurrences),
    );
    expect(remaining.map((row) => row.taskId)).not.toContain(parent!.id);
    expect(outcome.schedules[0]!.placements).toHaveLength(1);
  });

  it('reports a task with no estimate instead of placing it', async () => {
    const outcome = await create('How long is this?', { estimatedDurationMin: undefined });

    expect(outcome.schedules[0]!.placements).toHaveLength(0);
    expect(outcome.schedules[0]!.unschedulable).toEqual([
      expect.objectContaining({ reason: 'no_duration' }),
    ]);
  });

  it('reports a task with no category the same way', async () => {
    const outcome = await create('Uncategorised', { categoryId: undefined });

    expect(outcome.schedules[0]!.unschedulable).toEqual([
      expect.objectContaining({ reason: 'no_category' }),
    ]);
  });

  it('inherits a parent’s category rather than requiring its own', async () => {
    await create('Umbrella', { estimatedDurationMin: undefined });
    const [parent] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Umbrella')).limit(1),
    );

    const outcome = await create('Inheriting child', {
      parentId: parent!.id,
      categoryId: undefined,
    });

    expect(outcome.schedules[0]!.placements).toHaveLength(1);
    expect(outcome.schedules[0]!.unschedulable).toHaveLength(0);
  });
});

describe('editing tasks', () => {
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

  async function seed(params: Partial<CreateTaskParams> = {}): Promise<string> {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Subject',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        ...params,
      },
    });

    const [row] = await world.read((tx) =>
      tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, 'Subject')).limit(1),
    );
    return row!.id;
  }

  it('clears an override with null and leaves it alone when absent', async () => {
    const taskId = await seed({ priority: 4 });

    await world.run({ type: 'EditTask', params: { taskId, patch: { title: 'Renamed' } } });
    let [row] = await world.read((tx) =>
      tx.select({ priority: tasks.priority, title: tasks.title }).from(tasks).limit(1),
    );
    expect(row).toEqual({ priority: 4, title: 'Renamed' });

    await world.run({ type: 'EditTask', params: { taskId, patch: { priority: null } } });
    [row] = await world.read((tx) =>
      tx.select({ priority: tasks.priority, title: tasks.title }).from(tasks).limit(1),
    );
    expect(row!.priority).toBeNull();
  });

  it('drops a due date and its kind together', async () => {
    const taskId = await seed({ dueDate: { date: '2026-03-25T12:00:00Z', kind: 'hard' } });

    await world.run({ type: 'EditTask', params: { taskId, patch: { dueDate: null } } });

    const [row] = await world.read((tx) =>
      tx.select({ dueDate: tasks.dueDate, dueKind: tasks.dueKind }).from(tasks).limit(1),
    );
    expect(row).toEqual({ dueDate: null, dueKind: null });
  });

  it('re-places a task into its new category’s windows (spec §7.6)', async () => {
    const taskId = await seed();
    const errands = await world.read(async (tx) => {
      const [category] = await tx
        .insert(categories)
        .values({ tenantId: world.tenantId, name: 'Errands', defaultCooldownMin: 0 })
        .returning({ id: categories.id });
      // Errands only happen on Tuesday afternoons.
      await tx.insert(availabilityWindows).values({
        tenantId: world.tenantId,
        calendarId: world.calendarId,
        categoryId: category!.id,
        weekday: 2,
        startMin: 14 * 60,
        endMin: 16 * 60,
      });
      return category!.id;
    });

    const outcome = await world.run({
      type: 'EditTask',
      params: { taskId, patch: { categoryId: errands } },
    });

    // Tuesday 2026-03-24, 14:00 Berlin = 13:00 UTC.
    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-24T13:00:00Z'),
    );
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('reflows downstream tasks when an estimate grows (spec §7.6)', async () => {
    const first = await seed();
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Downstream',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    });

    await world.run({
      type: 'EditTask',
      params: { taskId: first, patch: { estimatedDurationMin: 180 } },
    });

    const placements = await world.cachedPlacements();
    const lengths = placements.map((p) => p.interval.end - p.interval.start).sort((a, b) => a - b);
    expect(lengths).toEqual([60, 180]);
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('refuses to edit a task that is not there', async () => {
    await expect(
      world.run({
        type: 'EditTask',
        params: { taskId: '018f3a2b-0000-7000-8000-0000000000ff', patch: { title: 'Nope' } },
      }),
    ).rejects.toThrow(/No task/);
  });
});

describe('appointments as hard blocks (spec §7.4)', () => {
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

  it('makes tasks reflow around a new appointment', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Deep work',
        categoryId: world.categoryId,
        estimatedDurationMin: 120,
      },
    });
    expect((await world.cachedPlacements())[0]!.interval.start).toBe(toInstant(MONDAY_0900));

    const outcome = await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Standup',
        start: '2026-03-23T08:00:00Z',
        end: '2026-03-23T09:00:00Z',
      },
    });

    // The task did not vanish and did not overlap: it moved past the block.
    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-23T09:00:00Z'),
    );
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('keeps the cooldown after an appointment clear as well', async () => {
    // §6.2 rule 3 from the block's side: the twenty minutes it takes to get
    // back from a meeting are not minutes anything else can have.
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Deep work',
        categoryId: world.categoryId,
        estimatedDurationMin: 120,
      },
    });

    const outcome = await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Across town',
        start: '2026-03-23T08:00:00Z',
        end: '2026-03-23T09:00:00Z',
        cooldownMin: 20,
      },
    });

    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-23T09:20:00Z'),
    );
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('accepts an appointment overlapping another, and keeps tasks out of both', async () => {
    const add = (start: string, end: string, title: string) =>
      world.run({
        type: 'AddAppointment',
        params: { calendarId: world.calendarId, title, start, end },
      });

    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Deep work',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    });

    // From the top of the working day, so the task has nowhere earlier to go.
    await add('2026-03-23T08:00:00Z', '2026-03-23T09:00:00Z', 'Conference');
    // Migration 0016: two things a person says are happening may be happening
    // at once. What must still hold is rule 2 — the task goes after both.
    const outcome = await add('2026-03-23T08:30:00Z', '2026-03-23T09:30:00Z', 'Keynote');

    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-23T09:30:00Z'),
    );
    expect(await validatePersistedSchedule(world)).toEqual({ valid: true, violations: [] });
  });

  it('allows an appointment that abuts another, since intervals are half-open', async () => {
    const add = (start: string, end: string) =>
      world.run({
        type: 'AddAppointment',
        params: { calendarId: world.calendarId, title: 'Meeting', start, end },
      });

    await add('2026-03-23T09:00:00Z', '2026-03-23T10:00:00Z');
    await expect(add('2026-03-23T10:00:00Z', '2026-03-23T11:00:00Z')).resolves.toBeDefined();
  });

  it('gives the time back when an appointment is cancelled', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Deep work',
        categoryId: world.categoryId,
        estimatedDurationMin: 120,
      },
    });
    const outcome = await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Standup',
        start: '2026-03-23T08:00:00Z',
        end: '2026-03-23T09:00:00Z',
      },
    });
    const appointmentId = await world.read(async (tx) => {
      const [row] = await tx.select({ id: appointments.id }).from(appointments).limit(1);
      return row!.id;
    });
    expect(outcome.schedules[0]!.placements[0]!.interval.start).toBe(
      toInstant('2026-03-23T09:00:00Z'),
    );

    const after = await world.run({
      type: 'EditAppointment',
      params: { appointmentId, patch: { status: 'cancelled' } },
    });

    // A cancelled block stops reserving time, which is the point of cancelling.
    expect(after.schedules[0]!.placements[0]!.interval.start).toBe(toInstant(MONDAY_0900));
  });
});

/**
 * Spec §4.4's due-date rule, as a caller experiences it.
 *
 * Enforced by a **deferred** trigger, which is what makes this worth its own
 * test: it fires at commit, after every handler has returned, so nothing inside
 * the transaction can catch it. Before M11 it reached a caller as a 500.
 */
describe('a child cannot be due after its container', () => {
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

  const due = (date: string) => ({ date, kind: 'soft' as const });

  it('refuses a child due after its parent, with a sentence about why', async () => {
    const parentId = await seedTask(world, 'Ship the thing', {
      dueDate: due('2026-03-27T17:00:00Z'),
    });

    const attempt = world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Write the docs',
        parentId,
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        dueDate: due('2026-04-03T17:00:00Z'),
      },
    });

    await expect(attempt).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(attempt).rejects.toThrow(/cannot be due after its parent/);
  });

  it('refuses tightening a parent past a child that was already legal', async () => {
    const parentId = await seedTask(world, 'Ship the thing', {
      dueDate: due('2026-04-03T17:00:00Z'),
    });
    await seedTask(world, 'Write the docs', {
      parentId,
      dueDate: due('2026-04-02T17:00:00Z'),
    });

    // The trigger walks the subtree rather than the changed row, which is the
    // only way this one is caught: the child did not change.
    await expect(
      world.run({
        type: 'EditTask',
        params: { taskId: parentId, patch: { dueDate: due('2026-03-27T17:00:00Z') } },
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('allows a child due exactly when its parent is', async () => {
    const parentId = await seedTask(world, 'Ship the thing', {
      dueDate: due('2026-03-27T17:00:00Z'),
    });

    // The rule is ≤, not <.
    await expect(
      world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title: 'Write the docs',
          parentId,
          categoryId: world.categoryId,
          estimatedDurationMin: 60,
          dueDate: due('2026-03-27T17:00:00Z'),
        },
      }),
    ).resolves.toBeDefined();
  });
});
