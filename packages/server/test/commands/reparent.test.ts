import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '../../src/commands/index.js';
import { taskOccurrences, tasks } from '../../src/db/schema/index.js';
import { readCalendarTaskTree } from '../../src/tasks/task-tree.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, validatePersistedSchedule, type World } from '../support/world.js';
import type { CreateTaskParams } from '@ambitime/shared';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * `SetTaskParent` — structure discovered after the fact (spec §4.4).
 *
 * `parent_id` was write-once: a task could be created under another and never
 * moved, so somebody had to know a piece of work belonged with others before
 * writing it down. The ordinary motion is the opposite — jot five things,
 * notice three are one job — and without this the only way to do it was to
 * delete and retype, losing the task's id, its history and its placement.
 *
 * Most of the rules are migration 0004's and are tested here through the
 * command rather than restated: the cycle check, the depth cap and the subtree
 * re-depth are triggers, and they fire on UPDATE exactly as they do on INSERT.
 * What the command owns is the occurrences, which no constraint can express.
 */

describe('moving a task in the tree', () => {
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

  async function create(title: string, params: Partial<CreateTaskParams> = {}): Promise<string> {
    const outcome = await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
        ...params,
      },
    });

    return outcome.created.find((row) => row.entity === 'task')!.id;
  }

  const move = (taskId: string, parentId: string | null) =>
    world.run({ type: 'SetTaskParent', params: { taskId, parentId } });

  const rowOf = async (taskId: string) => {
    const [row] = await world.read((tx) =>
      tx
        .select({ parentId: tasks.parentId, depth: tasks.depth })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1),
    );
    return row!;
  };

  it('puts a root task under another, and its depth follows', async () => {
    const project = await create('Billing revamp');
    const loose = await create('Write the changelog');

    await move(loose, project);

    expect(await rowOf(loose)).toEqual({ parentId: project, depth: 2 });
  });

  it('brings the subtree with it, re-depthed', async () => {
    // Two roots, one of them two deep already, and the whole of the second
    // moves under the first.
    const project = await create('Billing revamp');
    const migration = await create('Migrate the old rows');
    const dryRun = await create('Dry run on staging', { parentId: migration });

    await move(migration, project);

    expect((await rowOf(migration)).depth).toBe(2);
    expect(await rowOf(dryRun)).toEqual({ parentId: migration, depth: 3 });
  });

  it('takes a task back out to the top level', async () => {
    const project = await create('Billing revamp');
    const child = await create('Write the changelog', { parentId: project });

    await move(child, null);

    expect(await rowOf(child)).toEqual({ parentId: null, depth: 1 });
  });

  it('refuses a move that would make a task its own ancestor', async () => {
    // Migration 0004's ancestry walk. Without it the recursive reads spin.
    const project = await create('Billing revamp');
    const child = await create('Write the changelog', { parentId: project });

    await expect(move(project, child)).rejects.toThrow();
    expect((await rowOf(project)).parentId).toBeNull();
  });

  it('refuses to be its own parent', async () => {
    const project = await create('Billing revamp');

    await expect(move(project, project)).rejects.toThrow(PreconditionFailedError);
  });

  it('refuses a move that would push a descendant past depth five', async () => {
    // A four-deep chain moved under a depth-2 task would make its last node 6.
    const deep = await create('One');
    let leaf = deep;
    for (const title of ['Two', 'Three', 'Four']) leaf = await create(title, { parentId: leaf });

    const project = await create('Billing revamp');
    const under = await create('Phase one', { parentId: project });

    await expect(move(deep, under)).rejects.toThrow();
    expect((await rowOf(deep)).parentId).toBeNull();
  });
});

describe('what a move does to demand', () => {
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

  async function create(title: string, params: Partial<CreateTaskParams> = {}): Promise<string> {
    const outcome = await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
        ...params,
      },
    });
    return outcome.created.find((row) => row.entity === 'task')!.id;
  }

  const move = (taskId: string, parentId: string | null) =>
    world.run({ type: 'SetTaskParent', params: { taskId, parentId } });

  const pending = (taskId: string) =>
    world.read((tx) =>
      tx
        .select({ id: taskOccurrences.id })
        .from(taskOccurrences)
        .where(eq(taskOccurrences.taskId, taskId)),
    );

  it('retires the new parent’s occurrence, because it is no longer a unit of work', async () => {
    // Otherwise its placement sits in the schedule competing with its own
    // children for the same hours (§4.4).
    const project = await create('Billing revamp');
    const loose = await create('Write the changelog');
    expect(await pending(project)).toHaveLength(1);

    const outcome = await move(loose, project);

    expect(await pending(project)).toHaveLength(0);
    expect(outcome.schedules[0]!.placements).toHaveLength(1);
  });

  it('gives the old parent its occurrence back when the last child leaves', async () => {
    // The half no database constraint can state. It lost its occurrence when it
    // first gained a child; without a new one it is a task with an estimate,
    // no children, and nothing representing it — invisible to the solver *and*
    // to the "not being scheduled" list.
    const project = await create('Billing revamp');
    const onlyChild = await create('Write the changelog', { parentId: project });
    expect(await pending(project)).toHaveLength(0);

    const outcome = await move(onlyChild, null);

    expect(await pending(project)).toHaveLength(1);
    expect(outcome.schedules[0]!.placements).toHaveLength(2);
  });

  it('leaves a parent that still has other children alone', async () => {
    const project = await create('Billing revamp');
    const first = await create('Spec it', { parentId: project });
    await create('Write the changelog', { parentId: project });

    await move(first, null);

    expect(await pending(project)).toHaveLength(0);
  });

  it('re-places the moved task into what it now inherits', async () => {
    // §7.6: the subtree's effective activity type has changed, so where it may
    // go has changed, and the schedule that comes back says so.
    const project = await create('Billing revamp');
    const loose = await create('Write the changelog', { activityTypeId: undefined });

    // With no activity type of its own and no parent, it cannot be placed.
    const before = await world.run({
      type: 'EditTask',
      params: { taskId: loose, patch: { title: 'Write the changelog' } },
    });
    expect(before.schedules[0]!.unschedulable).toHaveLength(1);

    const after = await move(loose, project);

    expect(after.schedules[0]!.unschedulable).toHaveLength(0);
    expect(after.schedules[0]!.placements).toHaveLength(1);
    await validatePersistedSchedule(world);
  });

  it('is undone whole, occurrences included', async () => {
    const project = await create('Billing revamp');
    const loose = await create('Write the changelog');
    await move(loose, project);

    await world.run({ type: 'Undo', params: {} });

    const [row] = await world.read((tx) =>
      tx.select({ parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, loose)).limit(1),
    );
    expect(row!.parentId).toBeNull();
    // The occurrence the move deleted is back: undo restores rows, and the one
    // it removed from `project` was journalled like any other (§12).
    expect(await pending(project)).toHaveLength(1);
  });

  it('refuses to move a task under one in another planner', async () => {
    const project = await create('Billing revamp');
    const other = await world.run({
      type: 'CreateCalendar',
      params: { name: 'Second planner', timezone: 'Europe/Berlin' },
    });
    const elsewhere = other.created.find((row) => row.entity === 'calendar')!.id;
    const outcome = await world.run({
      type: 'CreateTask',
      params: { calendarId: elsewhere, title: 'Somewhere else', estimatedDurationMin: 60 },
    });
    const stranger = outcome.created.find((row) => row.entity === 'task')!.id;

    await expect(move(stranger, project)).rejects.toThrow(PreconditionFailedError);
  });

  it('says nothing changed when the task is already there', async () => {
    const project = await create('Billing revamp');
    const child = await create('Write the changelog', { parentId: project });

    await move(child, project);

    const [row] = await world.read((tx) =>
      tx.select({ version: tasks.version }).from(tasks).where(eq(tasks.id, child)).limit(1),
    );
    // Untouched rather than rewritten: a no-op that bumps the version would
    // invalidate every editor holding a lock on it for nothing.
    expect(row!.version).toBe(1);
  });
});

describe('a preference for certain weekdays', () => {
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

  const weekdaysOf = async (taskId: string) => {
    const [row] = await world.read((tx) =>
      tx.select({ own: tasks.preferredWeekdays }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
    );
    return row!.own;
  };

  async function create(title: string, params: Partial<CreateTaskParams> = {}): Promise<string> {
    const outcome = await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        activityTypeId: world.activityTypeId,
        estimatedDurationMin: 60,
        ...params,
      },
    });
    return outcome.created.find((row) => row.entity === 'task')!.id;
  }

  it('is stored sorted and de-duplicated, whatever order it arrives in', async () => {
    // The set is what was meant; the order somebody clicked the days in is not,
    // and a stored difference with no meaning is one the optimistic client and
    // the server can disagree about (§6.3).
    const taskId = await create('Weekly review', { preferredWeekdays: [4, 2, 2] });

    expect(await weekdaysOf(taskId)).toEqual([2, 4]);
  });

  it('is cleared on its own, without disturbing the hours', async () => {
    const taskId = await create('Weekly review', {
      preferredWeekdays: [2],
      preferredRange: { startMin: 13 * 60, endMin: 17 * 60 },
    });

    await world.run({
      type: 'EditTask',
      params: { taskId, patch: { preferredWeekdays: null } },
    });

    const [row] = await world.read((tx) =>
      tx
        .select({
          weekdays: tasks.preferredWeekdays,
          startMin: tasks.preferredStartMin,
          endMin: tasks.preferredEndMin,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1),
    );

    expect(row).toEqual({ weekdays: null, startMin: 13 * 60, endMin: 17 * 60 });
  });

  it('is inherited by everything under a container', async () => {
    // The whole reason it is worth having: "Tuesdays, 13:00–17:00" said once on
    // a project is said about every task in it (§4.4).
    const project = await create('Billing revamp', { preferredWeekdays: [2] });
    const child = await create('Write the changelog', { parentId: project });

    const tree = await world.read((tx) => readCalendarTaskTree(tx, world.calendarId));
    const node = tree.find((row) => row.id === child);

    expect(node?.ownPreferredWeekdays).toBeNull();
    expect(node?.effectivePreferredWeekdays).toEqual([2]);
  });
});
