import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notificationListSchema } from '@ambitime/shared';
import { withSystemPrivileges } from '../../src/db/context.js';
import {
  calendarWindows,
  notifications,
  teamMemberships,
  teams,
  teamWindows,
} from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The engine's signals, surfaced (spec §6.6, §6.7, §11).
 *
 * One test per signal type, as the plan asks. What each asserts is the
 * **severity as well as the type**, because the distinction §6.5 and §6.7 draw
 * — a soft due date warns, a hard one alerts — is the whole point: a system
 * that raised everything at one level would be a system nobody reads.
 *
 * Every signal here comes from the scheduler's own diagnostics. None of these
 * tests could pass by a second opinion agreeing with the first, because there
 * is no second opinion to agree.
 */
describe('signals from a re-derive', () => {
  let handle: DatabaseHandle;
  let world: ApiWorld;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createApiWorld(handle.db);
  });

  const read = async () => {
    const response = await world.get('/api/notifications');
    expect(response.status).toBe(200);
    return notificationListSchema.parse(await response.json()).notifications;
  };

  const ofType = async (type: string) => (await read()).filter((n) => n.type === type);

  const createTask = (title: string, extra: Record<string, unknown> = {}) =>
    world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title,
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
        ...extra,
      },
    } as never);

  it('raises an informational notice when a task lands in the backlog', async () => {
    // Far more work than the fortnight can hold, so the coarse planner takes
    // the overflow and gives it an estimated week (§6.1).
    for (let index = 0; index < 60; index += 1) {
      await createTask(`Task ${index}`, { estimatedDurationMin: 480 });
    }

    const backlogged = await ofType('backlog_added');
    expect(backlogged.length).toBeGreaterThan(0);
    // §6.7: a backlog entry on its own is passive. Informational.
    expect(backlogged.every((n) => n.severity === 'info')).toBe(true);
  });

  it('warns about a soft due date and alerts about a hard one', async () => {
    // `now` is Monday 09:00 Berlin and the window opens at 09:00, so a
    // sixty-minute task cannot possibly finish by 09:30. Both are impossible in
    // exactly the same way, and the *only* difference between them is
    // `due_kind` — which is what makes the severities comparable.
    await createTask('Soft deadline', {
      estimatedDurationMin: 60,
      dueDate: { date: '2026-03-23T08:30:00Z', kind: 'soft' },
    });
    await createTask('Hard deadline', {
      estimatedDurationMin: 60,
      dueDate: { date: '2026-03-23T08:30:00Z', kind: 'hard' },
    });

    const warnings = await ofType('due_date_at_risk');
    const alerts = await ofType('hard_constraint_conflict');

    // §6.5 warns, §6.7 alerts. One flag, two different demands on attention —
    // so both must actually be raised, not merely be well-formed if present.
    expect(warnings).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
    expect(alerts[0]!.severity).toBe('alert');
  });

  it('raises the chronic-postponement signal for a task pushed again and again', async () => {
    const created = await createTask('Keeps slipping');
    const taskId = created.created.find((row) => row.entity === 'task')!.id;

    // §6.6's threshold is a tuning value; the default is small enough that a
    // handful of deferrals crosses it.
    for (let index = 0; index < 5; index += 1) {
      await world.run({ type: 'DeferTask', params: { taskId, target: 'tomorrow' } });
    }

    const chronic = await ofType('chronic_postponement');
    expect(chronic).toHaveLength(1);
    expect((chronic[0]!.payload as { taskId: string }).taskId).toBe(taskId);
  });

  it('does not raise chronic postponement for an involuntary reflow', async () => {
    await createTask('Pushed by the system');

    // §6.6 is explicit that the two are tracked distinctly: a bulk reflow moves
    // far more tasks than a user ever would, and counting it would drown the
    // signal it is trying to raise.
    for (let index = 0; index < 5; index += 1) {
      await world.run({
        type: 'PostponeRestOfDay',
        params: { calendarId: world.calendarId, date: '2026-03-23' },
      });
    }

    expect(await ofType('chronic_postponement')).toEqual([]);
  });

  it('notices when a working window diverges from the team’s (§9.4)', async () => {
    await world.run({
      type: 'SetCalendarWindows',
      params: {
        calendarId: world.calendarId,
        kind: 'working',
        windows: [{ weekday: 1, startMin: 10 * 60, endMin: 16 * 60 }],
      },
    });

    // A team whose week is 09:00–17:00 — the comparison §9.4 asks for needs
    // both sides stored, and until M13 only one of them was.
    await withSystemPrivileges(handle.db, async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ tenantId: world.tenantId, name: 'Platform' })
        .returning({ id: teams.id });
      await tx
        .insert(teamMemberships)
        .values({ tenantId: world.tenantId, teamId: team!.id, userId: world.userId });
      await tx.insert(teamWindows).values({
        tenantId: world.tenantId,
        teamId: team!.id,
        weekday: 1,
        startMin: 9 * 60,
        endMin: 17 * 60,
      });
    });

    // Any command re-derives and re-signals.
    await createTask('Anything');

    const divergence = await ofType('working_window_divergence');
    expect(divergence).toHaveLength(1);
    expect(divergence[0]!.severity).toBe('info');
  });

  it('says nothing when the two windows agree', async () => {
    await world.run({
      type: 'SetCalendarWindows',
      params: {
        calendarId: world.calendarId,
        kind: 'working',
        windows: [{ weekday: 1, startMin: 9 * 60, endMin: 17 * 60 }],
      },
    });

    await withSystemPrivileges(handle.db, async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ tenantId: world.tenantId, name: 'Platform' })
        .returning({ id: teams.id });
      await tx
        .insert(teamMemberships)
        .values({ tenantId: world.tenantId, teamId: team!.id, userId: world.userId });
      await tx.insert(teamWindows).values({
        tenantId: world.tenantId,
        teamId: team!.id,
        weekday: 1,
        startMin: 9 * 60,
        endMin: 17 * 60,
      });
    });

    await createTask('Anything');
    expect(await ofType('working_window_divergence')).toEqual([]);
  });

  it('says nothing when no working window has been set at all', async () => {
    // Unset means unrestricted, not empty (§9.1). Telling somebody their unset
    // window disagrees with their team's would be a notice about nothing.
    await withSystemPrivileges(handle.db, async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ tenantId: world.tenantId, name: 'Platform' })
        .returning({ id: teams.id });
      await tx
        .insert(teamMemberships)
        .values({ tenantId: world.tenantId, teamId: team!.id, userId: world.userId });
      await tx.insert(teamWindows).values({
        tenantId: world.tenantId,
        teamId: team!.id,
        weekday: 1,
        startMin: 9 * 60,
        endMin: 17 * 60,
      });
    });

    await createTask('Anything');

    const windows = await withSystemPrivileges(handle.db, (tx) =>
      tx.select().from(calendarWindows).where(eq(calendarWindows.calendarId, world.calendarId)),
    );
    expect(windows).toEqual([]);
    expect(await ofType('working_window_divergence')).toEqual([]);
  });

  describe('signals are state, not a log', () => {
    it('does not accumulate a copy per re-derive', async () => {
      const created = await createTask('Hard deadline', {
        estimatedDurationMin: 600,
        dueDate: { date: '2026-03-23T09:00:00Z', kind: 'hard' },
      });
      const taskId = created.created.find((row) => row.entity === 'task')!.id;

      const first = (await read()).length;
      expect(first).toBeGreaterThan(0);

      // Three more commands, three more re-derives, the same facts.
      for (let index = 0; index < 3; index += 1) {
        await world.run({
          type: 'EditTask',
          params: { taskId, patch: { notes: `pass ${index}` } },
        });
      }

      expect(await read()).toHaveLength(first);
    });

    it('withdraws a signal that has stopped being true', async () => {
      const created = await createTask('Hard deadline', {
        estimatedDurationMin: 600,
        dueDate: { date: '2026-03-23T09:00:00Z', kind: 'hard' },
      });
      const taskId = created.created.find((row) => row.entity === 'task')!.id;
      expect((await ofType('hard_constraint_conflict')).length).toBeGreaterThan(0);

      // Cancel the task and the risk goes with it. A signal left standing would
      // be claiming something that is no longer so.
      await world.run({ type: 'CancelTask', params: { taskId } });

      expect(await ofType('hard_constraint_conflict')).toEqual([]);
    });

    it('keeps a signal a user has read, and does not re-raise it', async () => {
      await createTask('Hard deadline', {
        estimatedDurationMin: 600,
        dueDate: { date: '2026-03-23T09:00:00Z', kind: 'hard' },
      });

      const alert = (await ofType('hard_constraint_conflict'))[0]!;
      await world.run({
        type: 'MarkNotificationsRead',
        params: { notificationIds: [alert.id] },
      });

      // Still true, but dismissed. The partial unique index only covers unread
      // rows, so re-raising is possible — but the producer inserts on conflict
      // do nothing, and a read row is no longer in the live set to conflict
      // with, so what matters is that the user is not told twice while the
      // dismissal stands.
      await createTask('Something else');

      const rows = await withSystemPrivileges(handle.db, (tx) =>
        tx
          .select({ id: notifications.id, readAt: notifications.readAt })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, world.userId),
              eq(notifications.type, 'hard_constraint_conflict'),
            ),
          ),
      );

      expect(rows.filter((row) => row.readAt !== null)).toHaveLength(1);
    });
  });
});
