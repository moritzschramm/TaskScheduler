import { desc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newCommand, uuidv7, type CommandDraft } from '@ambitime/shared';
import {
  applyCommand,
  PreconditionFailedError,
  type CommandJournal,
} from '../../src/commands/index.js';
import { registerUser } from '../../src/identity/register-user.js';
import { addMember } from '../support/fixtures.js';
import { commands, taskOccurrences, tasks } from '../../src/db/schema/index.js';
import { toInstant } from '../../src/schedule/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import {
  createWorld,
  MONDAY_0900,
  placementOf,
  seedTask,
  taskExists,
  taskRow,
  validatePersistedSchedule,
  type World,
} from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Undo and redo (spec §7.5), backed by the command log (§12).
 *
 * The claim under test is that undo is **log-driven**: it reverses whatever the
 * log says the last command changed, using images that command recorded, rather
 * than a per-command inverse someone wrote by hand and might have got wrong. So
 * the suite reaches for the commands with the least in common — a create, a
 * manual reposition, a bulk reflow over many rows — and asks the same thing of
 * each: put it back, exactly.
 */
describe('undo and redo', () => {
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

  /** Every task's floor, which is what the deferral commands write. */
  async function floors(): Promise<Record<string, string | null>> {
    const rows = await world.read((tx) =>
      tx.select({ id: tasks.id, floor: tasks.manualFloor }).from(tasks).orderBy(tasks.id),
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.floor]));
  }

  const undo = () => world.run({ type: 'Undo', params: {} });
  const redo = () => world.run({ type: 'Redo', params: {} });

  describe('a single command', () => {
    it('puts a manual reposition back where it was', async () => {
      const taskId = await seedTask(world, 'Repositioned');
      const before = await world.cachedPlacements();

      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T09:00:00Z' } });
      expect(await world.cachedPlacements()).not.toEqual(before);

      await undo();

      expect((await taskRow(world, taskId)).manualFloor).toBeNull();
      expect(await world.cachedPlacements()).toEqual(before);
    });

    it('un-creates a task, occurrence and all', async () => {
      const kept = await seedTask(world, 'Kept');
      const before = await world.cachedPlacements();

      const doomed = await seedTask(world, 'Doomed');
      expect(await placementOf(world, doomed)).toBeDefined();

      await undo();

      expect(await taskExists(world, doomed)).toBe(false);
      // The occurrence went with it: undo walks the change set backwards, so
      // the row that referenced the task is removed before the task itself.
      const occurrences = await world.read((tx) =>
        tx.select({ id: taskOccurrences.id }).from(taskOccurrences),
      );
      expect(occurrences).toHaveLength(1);
      expect(await placementOf(world, kept)).toBeDefined();
      expect(await world.cachedPlacements()).toEqual(before);
    });

    it('restores a completed task to active', async () => {
      const taskId = await seedTask(world, 'Finished');
      await world.run({ type: 'CompleteTask', params: { taskId } });
      expect(await placementOf(world, taskId)).toBeUndefined();

      await undo();

      const row = await taskRow(world, taskId);
      expect(row.status).toBe('active');
      expect(row.completedAt).toBeNull();
      expect(await placementOf(world, taskId)).toBeDefined();
    });

    it('restores a cancelled subtree in one step', async () => {
      const parent = await seedTask(world, 'Project');
      const child = await seedTask(world, 'Subtask');
      await world.run({ type: 'EditTask', params: { taskId: child, patch: { title: 'Subtask' } } });
      await world.run({ type: 'CancelTask', params: { taskId: parent } });

      await undo();

      expect((await taskRow(world, parent)).status).toBe('active');
    });
  });

  describe('a bulk action, atomically (§7.2, §7.5)', () => {
    it('restores every floor a sick day replaced, and the schedule with them', async () => {
      const ids = [
        await seedTask(world, 'Morning'),
        await seedTask(world, 'Midday'),
        await seedTask(world, 'Afternoon'),
      ];
      // One task already positioned by hand, so the undo has a real prior value
      // to restore rather than a column full of nulls.
      await world.run({
        type: 'MoveTask',
        params: { taskId: ids[2]!, datetime: '2026-03-23T13:00:00Z' },
      });

      const beforeFloors = await floors();
      const beforePlacements = await world.cachedPlacements();

      await world.run({
        type: 'PostponeRestOfDay',
        params: { calendarId: world.calendarId, date: '2026-03-23' },
      });

      // The day really did clear: all three moved off Monday.
      const cleared = await floors();
      expect(Object.values(cleared).every((floor) => floor !== null)).toBe(true);
      expect(cleared).not.toEqual(beforeFloors);

      await undo();

      expect(await floors()).toEqual(beforeFloors);
      expect(await world.cachedPlacements()).toEqual(beforePlacements);
      expect(await validatePersistedSchedule(world)).toMatchObject({ valid: true });
    });
  });

  describe('a command group', () => {
    it('reverses every command in the group, or none of them', async () => {
      const first = await seedTask(world, 'First');
      const second = await seedTask(world, 'Second');
      const beforeFloors = await floors();

      const groupId = uuidv7();
      await world.run({
        type: 'MoveTask',
        groupId,
        params: { taskId: first, datetime: '2026-03-24T09:00:00Z' },
      });
      await world.run({
        type: 'MoveTask',
        groupId,
        params: { taskId: second, datetime: '2026-03-25T09:00:00Z' },
      });

      // One press, both commands.
      await undo();

      expect(await floors()).toEqual(beforeFloors);
    });

    it('does not sweep up a neighbouring command that is not in the group', async () => {
      const grouped = await seedTask(world, 'Grouped');
      const alone = await seedTask(world, 'Alone');

      const groupId = uuidv7();
      await world.run({
        type: 'MoveTask',
        groupId,
        params: { taskId: grouped, datetime: '2026-03-24T09:00:00Z' },
      });
      await world.run({
        type: 'MoveTask',
        params: { taskId: alone, datetime: '2026-03-25T09:00:00Z' },
      });

      await undo();

      expect((await taskRow(world, alone)).manualFloor).toBeNull();
      expect((await taskRow(world, grouped)).manualFloor).not.toBeNull();
    });
  });

  describe('the stacks', () => {
    it('replays what it reversed', async () => {
      const taskId = await seedTask(world, 'Repositioned');
      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T09:00:00Z' } });
      const moved = await world.cachedPlacements();
      const movedFloor = (await taskRow(world, taskId)).manualFloor;

      await undo();
      await redo();

      expect((await taskRow(world, taskId)).manualFloor).toBe(movedFloor);
      expect(await world.cachedPlacements()).toEqual(moved);
    });

    it('walks back through several commands, one press at a time', async () => {
      const taskId = await seedTask(world, 'Shuffled');
      const start = await world.cachedPlacements();

      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-24T09:00:00Z' } });
      const afterFirst = await world.cachedPlacements();
      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T09:00:00Z' } });

      await undo();
      expect(await world.cachedPlacements()).toEqual(afterFirst);

      await undo();
      expect(await world.cachedPlacements()).toEqual(start);
    });

    it('discards the redo stack once something new is done', async () => {
      const taskId = await seedTask(world, 'Repositioned');
      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T09:00:00Z' } });
      await undo();

      // A new command means the branch of history redo pointed at is not the
      // one being lived any more.
      await world.run({ type: 'ExtendTask', params: { taskId, newEstimateMin: 90 } });

      await expect(redo()).rejects.toBeInstanceOf(PreconditionFailedError);
    });

    it('says so when there is nothing to undo or redo', async () => {
      await expect(undo()).rejects.toBeInstanceOf(PreconditionFailedError);
      await expect(redo()).rejects.toBeInstanceOf(PreconditionFailedError);
    });
  });

  describe('sharing a tenant with somebody else', () => {
    /** A second member of the same tenant, acting on the same calendar. */
    async function colleague(): Promise<(draft: CommandDraft) => Promise<unknown>> {
      const user = await registerUser(world.db, { email: `colleague-${Date.now()}@example.test` });
      await addMember(world.db, world.tenantId, user.userId, 'member');

      return (draft) =>
        applyCommand(
          world.db,
          newCommand({ ...draft, actor: user.userId, tenantId: world.tenantId } as CommandDraft, {
            issuedAt: MONDAY_0900,
          }),
        );
    }

    it('undoes my last command, not theirs — and re-derives around what they did', async () => {
      const taskId = await seedTask(world, 'Mine');
      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T09:00:00Z' } });

      // Meanwhile, somebody else blocks out this morning.
      const theirs = await colleague();
      await theirs({
        type: 'AddUnavailability',
        params: {
          calendarId: world.calendarId,
          start: '2026-03-23T08:00:00Z',
          end: '2026-03-23T10:00:00Z',
        },
      } as CommandDraft);

      await undo();

      // My reposition is gone — but the task did not go back to the 08:00 slot
      // it held when I issued it, because that time is no longer free. The
      // schedule was recomputed from restored source, not restored alongside it.
      expect((await taskRow(world, taskId)).manualFloor).toBeNull();
      expect((await placementOf(world, taskId))!.interval.start).toBe(
        toInstant('2026-03-23T10:00:00Z'),
      );

      // And their block is still standing: undo reached into my history only.
      const blocks = await world.read((tx) => tx.select({ id: commands.id }).from(commands));
      expect(blocks).toHaveLength(4);
      expect(await validatePersistedSchedule(world)).toMatchObject({ valid: true });
    });
  });

  describe('the log', () => {
    it('records the undo as a command naming what it reversed', async () => {
      const taskId = await seedTask(world, 'Repositioned');
      const moved = await world.run({
        type: 'MoveTask',
        params: { taskId, datetime: '2026-03-25T09:00:00Z' },
      });

      await undo();

      const [entry] = await world.read((tx) =>
        tx
          .select({ type: commands.type, inverse: commands.inverse })
          .from(commands)
          .orderBy(desc(commands.seq))
          .limit(1),
      );

      expect(entry!.type).toBe('Undo');
      // Not a flag flipped on the command it reversed — that row is untouched,
      // and could not be touched: the log has UPDATE revoked (§12).
      expect((entry!.inverse as CommandJournal).targets).toEqual([moved.command.id]);
    });

    it('keeps every command it ever accepted, undone or not', async () => {
      const taskId = await seedTask(world, 'Repositioned');
      await world.run({ type: 'MoveTask', params: { taskId, datetime: '2026-03-25T09:00:00Z' } });
      await undo();
      await redo();

      const log = await world.read((tx) =>
        tx.select({ type: commands.type }).from(commands).orderBy(commands.seq),
      );

      expect(log.map((row) => row.type)).toEqual(['CreateTask', 'MoveTask', 'Undo', 'Redo']);
    });
  });
});
