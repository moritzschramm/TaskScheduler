import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemPrivileges } from '../src/db/context.js';
import { appointments, tasks } from '../src/db/schema/index.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { captureSqlState, SQLSTATE } from './support/errors.js';
import { addMember, createWorkTenant, registerUser } from './support/fixtures.js';
import {
  createAppointment,
  createAvailabilityWindow,
  createCalendar,
  createCategory,
  createTask,
  createTaskChain,
  tstzrangeLiteral,
} from './support/scheduling-fixtures.js';
import { resetDomainTables, setupTestDatabase } from './support/database.js';

/** SQLSTATE 23P01: an exclusion constraint rejected the row. */
const EXCLUSION_VIOLATION = '23P01';

describe('scheduling-domain constraints', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let userId: string;
  let calendarId: string;
  let base: { tenantId: string; calendarId: string; ownerId: string };

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    userId = (await registerUser(handle.db, { email: 'planner@example.com' })).userId;
    tenantId = await createWorkTenant(handle.db, 'Work');
    await addMember(handle.db, tenantId, userId, 'owner');
    calendarId = await createCalendar(handle.db, tenantId, userId);
    base = { tenantId, calendarId, ownerId: userId };
  });

  describe('appointment non-overlap (spec §5.3, §6.2)', () => {
    it('accepts appointments that merely touch', async () => {
      // Intervals are half-open, so 09:00–10:00 and 10:00–11:00 do not conflict
      // (spec §5.1). This is the case a closed-interval model gets wrong.
      await createAppointment(handle.db, {
        ...base,
        title: 'Standup',
        during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
      });

      await expect(
        createAppointment(handle.db, {
          ...base,
          title: 'Review',
          during: tstzrangeLiteral('2026-03-02T10:00:00Z', '2026-03-02T11:00:00Z'),
        }),
      ).resolves.toBeTruthy();
    });

    it('rejects a genuinely overlapping appointment in the same calendar', async () => {
      await createAppointment(handle.db, {
        ...base,
        title: 'Dentist',
        during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
      });

      const state = await captureSqlState(() =>
        createAppointment(handle.db, {
          ...base,
          title: 'Clashing call',
          during: tstzrangeLiteral('2026-03-02T09:30:00Z', '2026-03-02T10:30:00Z'),
        }),
      );

      expect(state).toBe(EXCLUSION_VIOLATION);
    });

    it('allows the same slot in a different calendar', async () => {
      // The constraint is scoped per calendar; separate contexts schedule
      // independently (spec §9.3).
      const otherCalendar = await createCalendar(handle.db, tenantId, userId, 'Personal');

      await createAppointment(handle.db, {
        ...base,
        title: 'Work block',
        during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
      });

      await expect(
        createAppointment(handle.db, {
          ...base,
          calendarId: otherCalendar,
          title: 'Personal block',
          during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
        }),
      ).resolves.toBeTruthy();
    });

    it('frees the slot once an appointment is cancelled', async () => {
      const first = await createAppointment(handle.db, {
        ...base,
        title: 'Cancelled thing',
        during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
      });

      await withSystemPrivileges(handle.db, (tx) =>
        tx.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, first)),
      );

      await expect(
        createAppointment(handle.db, {
          ...base,
          title: 'Replacement',
          during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
        }),
      ).resolves.toBeTruthy();
    });

    it('treats an unavailability block like any other fixed block', async () => {
      // Spec §7.4: a content-free hard block behaves as an appointment does.
      await createAppointment(handle.db, {
        ...base,
        title: 'Unavailable',
        isUnavailability: true,
        during: tstzrangeLiteral('2026-03-02T14:00:00Z', '2026-03-02T16:00:00Z'),
      });

      const state = await captureSqlState(() =>
        createAppointment(handle.db, {
          ...base,
          title: 'Meeting',
          during: tstzrangeLiteral('2026-03-02T15:00:00Z', '2026-03-02T15:30:00Z'),
        }),
      );

      expect(state).toBe(EXCLUSION_VIOLATION);
    });
  });

  describe('task hierarchy depth (spec §4.4)', () => {
    it('accepts a five-deep tree and maintains depth automatically', async () => {
      const ids = await createTaskChain(handle.db, base, 5);

      const rows = await handle.db
        .select({ id: tasks.id, depth: tasks.depth })
        .from(tasks)
        .orderBy(tasks.depth);

      expect(rows.map((r) => r.depth)).toEqual([1, 2, 3, 4, 5]);
      expect(rows.map((r) => r.id)).toEqual(ids);
    });

    it('rejects a sixth level', async () => {
      const ids = await createTaskChain(handle.db, base, 5);

      const state = await captureSqlState(() =>
        createTask(handle.db, { ...base, title: 'Level 6', parentId: ids[4]! }),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects re-parenting that would push a subtree past the cap', async () => {
      // The moved node itself would only reach depth 4; its descendants are what
      // breach the cap, which is why the resync trigger has to re-check them.
      const trunk = await createTaskChain(handle.db, base, 3);
      const branch = await createTaskChain(handle.db, base, 3);

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.update(tasks).set({ parentId: trunk[2]! }).where(eq(tasks.id, branch[0]!)),
        ),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('re-derives descendant depths when a subtree moves', async () => {
      const trunk = await createTaskChain(handle.db, base, 2);
      const branch = await createTaskChain(handle.db, base, 2);

      await withSystemPrivileges(handle.db, (tx) =>
        tx.update(tasks).set({ parentId: trunk[1]! }).where(eq(tasks.id, branch[0]!)),
      );

      const [movedRoot] = await handle.db
        .select({ depth: tasks.depth })
        .from(tasks)
        .where(eq(tasks.id, branch[0]!));
      const [movedChild] = await handle.db
        .select({ depth: tasks.depth })
        .from(tasks)
        .where(eq(tasks.id, branch[1]!));

      expect(movedRoot?.depth).toBe(3);
      expect(movedChild?.depth).toBe(4);
    });

    it('rejects a task becoming its own parent', async () => {
      const [root] = await createTaskChain(handle.db, base, 1);

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.update(tasks).set({ parentId: root! }).where(eq(tasks.id, root!)),
        ),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects a cycle through an ancestor', async () => {
      // Without this check the recursive reads would spin forever.
      const ids = await createTaskChain(handle.db, base, 3);

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.update(tasks).set({ parentId: ids[2]! }).where(eq(tasks.id, ids[0]!)),
        ),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('deletes the subtree with its root', async () => {
      const ids = await createTaskChain(handle.db, base, 3);

      await withSystemPrivileges(handle.db, (tx) => tx.delete(tasks).where(eq(tasks.id, ids[0]!)));

      expect(await handle.db.select({ id: tasks.id }).from(tasks)).toEqual([]);
    });
  });

  describe('inherited due dates (spec §4.4)', () => {
    const parentDue = '2026-04-10T12:00:00Z';

    it('accepts a child due before its parent', async () => {
      const parent = await createTask(handle.db, {
        ...base,
        title: 'Container',
        dueDate: parentDue,
        dueKind: 'hard',
      });

      await expect(
        createTask(handle.db, {
          ...base,
          title: 'Subtask',
          parentId: parent,
          dueDate: '2026-04-09T12:00:00Z',
          dueKind: 'soft',
        }),
      ).resolves.toBeTruthy();
    });

    it('rejects a child due after its parent', async () => {
      const parent = await createTask(handle.db, {
        ...base,
        title: 'Container',
        dueDate: parentDue,
        dueKind: 'hard',
      });

      const state = await captureSqlState(() =>
        createTask(handle.db, {
          ...base,
          title: 'Late subtask',
          parentId: parent,
          dueDate: '2026-04-11T12:00:00Z',
          dueKind: 'soft',
        }),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('compares against the nearest ancestor that sets a due date', async () => {
      // The middle task sets none, so the grandchild inherits the grandparent's
      // — the "effective" in "effective due date" (spec §4.4).
      const grandparent = await createTask(handle.db, {
        ...base,
        title: 'Grandparent',
        dueDate: parentDue,
        dueKind: 'hard',
      });
      const middle = await createTask(handle.db, {
        ...base,
        title: 'Middle',
        parentId: grandparent,
      });

      const state = await captureSqlState(() =>
        createTask(handle.db, {
          ...base,
          title: 'Grandchild',
          parentId: middle,
          dueDate: '2026-04-11T12:00:00Z',
          dueKind: 'soft',
        }),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects tightening a parent past an existing child', async () => {
      // The violation is introduced by the *parent's* edit, so checking only the
      // edited row would miss it entirely.
      const parent = await createTask(handle.db, {
        ...base,
        title: 'Container',
        dueDate: parentDue,
        dueKind: 'hard',
      });
      await createTask(handle.db, {
        ...base,
        title: 'Subtask',
        parentId: parent,
        dueDate: '2026-04-09T12:00:00Z',
        dueKind: 'soft',
      });

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.update(tasks).set({ dueDate: '2026-04-01T12:00:00Z' }).where(eq(tasks.id, parent)),
        ),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('allows moving a parent and its child together in one transaction', async () => {
      // What the deferred constraint trigger exists for: the intermediate state
      // is inconsistent, the committed state is not.
      const parent = await createTask(handle.db, {
        ...base,
        title: 'Container',
        dueDate: parentDue,
        dueKind: 'hard',
      });
      const child = await createTask(handle.db, {
        ...base,
        title: 'Subtask',
        parentId: parent,
        dueDate: '2026-04-09T12:00:00Z',
        dueKind: 'soft',
      });

      await withSystemPrivileges(handle.db, async (tx) => {
        await tx.update(tasks).set({ dueDate: '2026-04-02T12:00:00Z' }).where(eq(tasks.id, parent));
        await tx.update(tasks).set({ dueDate: '2026-04-01T12:00:00Z' }).where(eq(tasks.id, child));
      });

      const [row] = await handle.db
        .select({ dueDate: tasks.dueDate })
        .from(tasks)
        .where(eq(tasks.id, child));
      expect(row?.dueDate).toContain('2026-04-01');
    });

    it('rejects re-parenting a task under a container due earlier', async () => {
      const strict = await createTask(handle.db, {
        ...base,
        title: 'Strict container',
        dueDate: '2026-04-05T12:00:00Z',
        dueKind: 'hard',
      });
      const loose = await createTask(handle.db, {
        ...base,
        title: 'Late task',
        dueDate: '2026-04-20T12:00:00Z',
        dueKind: 'soft',
      });

      const state = await captureSqlState(() =>
        withSystemPrivileges(handle.db, (tx) =>
          tx.update(tasks).set({ parentId: strict }).where(eq(tasks.id, loose)),
        ),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });
  });

  describe('column-level invariants', () => {
    it('requires a due kind alongside a due date', async () => {
      const state = await captureSqlState(() =>
        createTask(handle.db, { ...base, title: 'Ambiguous', dueDate: '2026-04-10T12:00:00Z' }),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects a preferred range that ends before it starts', async () => {
      const state = await captureSqlState(() =>
        createTask(handle.db, {
          ...base,
          title: 'Backwards',
          preferredStartMin: 600,
          preferredEndMin: 540,
        }),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects a focus level outside 1–5', async () => {
      const state = await captureSqlState(() =>
        createTask(handle.db, { ...base, title: 'Too focused', focusLevel: 6 }),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects a recurrence period without a count', async () => {
      const state = await captureSqlState(() =>
        createTask(handle.db, { ...base, title: 'Half a rule', recurrencePeriod: 'week' }),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects a completed task with no completion time', async () => {
      const state = await captureSqlState(() =>
        createTask(handle.db, { ...base, title: 'Done?', status: 'completed' }),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects an appointment recurrence rule without a timezone', async () => {
      // Spec §5.1: a wall-clock rule needs its zone to survive DST.
      const state = await captureSqlState(() =>
        createAppointment(handle.db, {
          ...base,
          title: 'Weekly',
          during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
        }),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('accepts a recurrence rule that carries its timezone', async () => {
      await expect(
        createAppointment(handle.db, {
          ...base,
          title: 'Weekly',
          during: tstzrangeLiteral('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'),
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
          recurrenceTimezone: 'Europe/Berlin',
        }),
      ).resolves.toBeTruthy();
    });

    it('rejects an availability window running past midnight', async () => {
      // A window crossing midnight is modelled as two rows, which keeps every
      // comparison in the engine plain integer arithmetic.
      const categoryId = await createCategory(handle.db, tenantId, 'Work');

      const state = await captureSqlState(() =>
        createAvailabilityWindow(handle.db, {
          tenantId,
          calendarId,
          categoryId,
          weekday: 1,
          startMin: 600,
          endMin: 1500,
        }),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });

    it('rejects an availability window on a weekday outside 1–7', async () => {
      const categoryId = await createCategory(handle.db, tenantId, 'Work');

      const state = await captureSqlState(() =>
        createAvailabilityWindow(handle.db, {
          tenantId,
          calendarId,
          categoryId,
          weekday: 0,
          startMin: 540,
          endMin: 600,
        }),
      );

      expect(state).toBe(SQLSTATE.checkViolation);
    });
  });
});
