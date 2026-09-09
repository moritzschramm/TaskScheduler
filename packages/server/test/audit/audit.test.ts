import { desc, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditResponseSchema } from '@ambitime/shared';
import { compactJournals } from '../../src/audit/compact.js';
import { pruneAudit } from '../../src/audit/read.js';
import { commands, tasks } from '../../src/db/schema/index.js';
import { withSystemPrivileges } from '../../src/db/context.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import { AUTH_LIMIT, COMMAND_LIMIT, rateLimit } from '../../src/api/rate-limit.js';
import type { CommandJournal } from '../../src/commands/journal.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The audit view (spec §12) and §14's hardening.
 *
 * The claim §12 makes is that *one* log serves undo, history and audit. So the
 * test that matters is reconstruction: the sequence of commands read back has
 * to be the sequence that was issued, in order, with who issued each. A
 * separate audit trail could pass a shape test and still have drifted; this one
 * cannot, because there is nothing for it to drift from.
 */
describe('the audit view', () => {
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

  const audit = async (query = '') => {
    const response = await world.get(`/api/audit${query}`);
    expect(response.status).toBe(200);
    return auditResponseSchema.parse(await response.json());
  };

  it('reconstructs what was done, in order, with who did it', async () => {
    const created = await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Write the report',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    } as never);
    const taskId = created.created.find((row) => row.entity === 'task')!.id;

    await world.run({
      type: 'MoveTask',
      params: { taskId, datetime: '2026-03-24T13:00:00Z' },
    } as never);
    await world.run({ type: 'ClearFloor', params: { taskId } } as never);
    await world.run({ type: 'Undo', params: {} } as never);

    const { entries } = await audit();

    // Newest first, and the whole history including the fixture's own setup.
    expect(entries.slice(0, 4).map((entry) => entry.type)).toEqual([
      'Undo',
      'ClearFloor',
      'MoveTask',
      'CreateTask',
    ]);

    // Undo is in the log like anything else: taking something back is itself
    // something you did (§7.5), and an audit that hid it would be lying by
    // omission.
    expect(entries[0]!.actorEmail).toMatch(/@example\.test$/);
    expect(entries.every((entry) => entry.actorId === world.userId)).toBe(true);
  });

  it('counts the tasks a command touched, without shipping the row images', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Write the report',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    } as never);

    const [latest] = (await audit()).entries;

    // One task, though the create wrote two rows: it inserted the task and its
    // occurrence, and a person who made one thing did not make two.
    expect(latest!.affectedTasks).toBe(1);
    expect(latest!.calendarIds).toContain(world.calendarId);
    expect(JSON.stringify(latest)).not.toContain('"before"');
  });

  /**
   * The reason the count is not `changes.length`.
   *
   * `BlockOutDay` writes one row — an unavailability — and moves everything
   * that was on the day. A row count answers "1", which is true about the
   * database and useless about the week; the history is read by somebody asking
   * what the button did to their tasks.
   */
  it('counts the tasks a command moved, not the rows it wrote', async () => {
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      await world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title,
          categoryId: world.categoryId,
          estimatedDurationMin: 120,
        },
      } as never);
    }

    await world.run({
      type: 'BlockOutDay',
      params: { calendarId: world.calendarId, date: '2026-03-23' },
    } as never);

    const [latest] = (await audit()).entries;
    expect(latest!.type).toBe('BlockOutDay');
    expect(latest!.affectedTasks).toBe(3);
  });

  it('says it does not know, rather than none, for an entry from before it counted', async () => {
    await world.run({
      type: 'CreateTask',
      params: {
        calendarId: world.calendarId,
        title: 'Older than the field',
        categoryId: world.categoryId,
        estimatedDurationMin: 60,
      },
    } as never);

    // What a row written before `affectedTasks` existed looks like: an inverse
    // with changes and calendars in it and no count.
    await withSystemPrivileges(handle.db, (tx) =>
      tx.execute(
        sql`update commands set inverse = inverse - 'affectedTasks' where type = 'CreateTask'`,
      ),
    );

    const [latest] = (await audit()).entries;
    expect(latest!.affectedTasks).toBeNull();
  });

  it('pages on the log’s own order, not on a timestamp', async () => {
    for (let index = 0; index < 6; index += 1) {
      await world.run({
        type: 'CreateCategory',
        params: { name: `Category ${index}` },
      } as never);
    }

    const first = await world.get('/api/audit');
    const firstPage = auditResponseSchema.parse(await first.json());
    expect(firstPage.entries.length).toBeGreaterThan(0);

    // Two commands can share an `issued_at`; `seq` is a bigserial and cannot,
    // which is why it is the cursor rather than a timestamp.
    const paged = await audit(`?before=${firstPage.entries[2]!.seq}`);
    expect(paged.entries[0]!.seq).toBe(firstPage.entries[3]!.seq);
  });

  it('says how long history is kept', async () => {
    // Unset means for ever, which is the safe default: undo reads the same log,
    // so a retention window is also a limit on how far back a mistake can be
    // taken.
    expect((await audit()).retentionDays).toBeNull();
  });

  it('prunes past the retention window, and undo goes with it', async () => {
    await world.run({
      type: 'CreateCategory',
      params: { name: 'Old' },
    } as never);

    const before = (await audit()).entries.length;
    expect(before).toBeGreaterThan(0);

    // Everything in this world was issued at the pinned Monday, so a window
    // measured from a year later covers all of it.
    const pruned = await withSystemPrivileges(handle.db, (tx) =>
      pruneAudit(tx, 30, new Date('2027-03-23T09:00:00Z')),
    );

    expect(pruned).toBe(before);
    expect((await audit()).entries).toEqual([]);
  });

  /**
   * Compaction (§12), which is not retention.
   *
   * Retention forgets that something was done. This forgets only *how to put it
   * back* — and only once undo has stopped being able to, which the window it
   * reads has already decided. So the assertions that matter are the two
   * negatives: the audit view reads identically afterwards, and everything
   * still inside the window still reverses.
   */
  describe('compacting the journals past the undo window', () => {
    const log = () =>
      withSystemPrivileges(handle.db, (tx) =>
        tx
          .select({ type: commands.type, inverse: commands.inverse })
          .from(commands)
          .orderBy(desc(commands.seq)),
      );

    const compact = (depth?: number) =>
      withSystemPrivileges(handle.db, (tx) =>
        depth === undefined ? compactJournals(tx) : compactJournals(tx, depth),
      );

    const seed = (title: string) =>
      world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title,
          categoryId: world.categoryId,
          estimatedDurationMin: 60,
        },
      } as never);

    it('drops the row images, and only those', async () => {
      for (const title of ['Alpha', 'Beta', 'Gamma']) await seed(title);

      // Four: the fixture's calendar, category and hours, and Alpha's create.
      // Past a window two deep, no press of undo can reach any of them.
      expect(await compact(2)).toBe(4);

      const rows = await log();
      const journals = rows.map((row) => row.inverse as CommandJournal);

      expect(journals.slice(0, 2).every((journal) => journal.changes.length > 0)).toBe(true);
      expect(journals.slice(2).every((journal) => journal.changes === undefined)).toBe(true);
      expect(journals.slice(2).every((journal) => journal.stripped === true)).toBe(true);

      // Nothing was deleted, and nothing about a calendar was forgotten: the
      // entry stays, and so does everything the audit view asks it.
      expect(rows.map((row) => row.type)).toEqual([
        'CreateTask',
        'CreateTask',
        'CreateTask',
        'SetAvailabilityWindows',
        'CreateCategory',
        'CreateCalendar',
      ]);
      // What the audit view asks of a stripped entry, still answered: Alpha's
      // create names its calendar and still says it made one task.
      expect(journals[2]).toMatchObject({
        stripped: true,
        calendarIds: [world.calendarId],
        affectedTasks: 1,
      });

      // A second pass has nothing to do, which is what makes running this
      // nightly for ever cost what one night's commands cost.
      expect(await compact(2)).toBe(0);
    });

    it('leaves the audit view reading exactly as it did', async () => {
      await seed('Alpha');
      await seed('Beta');

      const before = await audit();
      await compact(1);

      expect(await audit()).toEqual(before);
    });

    it('leaves the window itself reversible', async () => {
      await seed('Alpha');
      await seed('Beta');
      await compact(1);

      await world.run({ type: 'Undo', params: {} } as never);

      const remaining = await withSystemPrivileges(handle.db, (tx) =>
        tx.select({ title: tasks.title }).from(tasks),
      );
      expect(remaining.map((row) => row.title)).toEqual(['Alpha']);
    });

    it('does nothing while the whole log is still inside the window', async () => {
      await seed('Alpha');
      expect(await compact()).toBe(0);
    });
  });
});

/**
 * §14's rate limiting.
 *
 * What is asserted is the contract a client sees: a refusal in the API's own
 * error shape, with `Retry-After`, and a budget that is per route class rather
 * than global — one runaway loop should not black out the application for the
 * person running it.
 */
describe('rate limiting', () => {
  const call = async (handler: ReturnType<typeof rateLimit>, times: number) => {
    const { Hono } = await import('hono');
    const app = new Hono().use('*', handler).get('/', (c) => c.json({ ok: true }));

    const statuses: number[] = [];
    for (let index = 0; index < times; index += 1) {
      const response = await app.request('/', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      statuses.push(response.status);
    }
    return statuses;
  };

  it('refuses once the budget is spent', async () => {
    const statuses = await call(rateLimit({ limit: 3, windowMs: 60_000 }), 5);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('answers in the API’s own error shape, with Retry-After', async () => {
    const { Hono } = await import('hono');
    const app = new Hono()
      .use('*', rateLimit({ limit: 1, windowMs: 60_000 }))
      .get('/', (c) => c.json({ ok: true }));

    await app.request('/', { headers: { 'x-forwarded-for': '203.0.113.8' } });
    const refused = await app.request('/', { headers: { 'x-forwarded-for': '203.0.113.8' } });

    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeTruthy();

    // A client should handle this the way it handles every other refusal
    // rather than by guessing at a bare status.
    const body = (await refused.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
  });

  it('counts each caller separately', async () => {
    const handler = rateLimit({ limit: 1, windowMs: 60_000 });
    const { Hono } = await import('hono');
    const app = new Hono().use('*', handler).get('/', (c) => c.json({ ok: true }));

    await app.request('/', { headers: { 'x-forwarded-for': '198.51.100.1' } });
    const other = await app.request('/', { headers: { 'x-forwarded-for': '198.51.100.2' } });

    expect(other.status).toBe(200);
  });

  it('lets the window pass', async () => {
    let clock = 0;
    const handler = rateLimit({ limit: 1, windowMs: 1_000, now: () => clock });
    const { Hono } = await import('hono');
    const app = new Hono().use('*', handler).get('/', (c) => c.json({ ok: true }));

    const send = () => app.request('/', { headers: { 'x-forwarded-for': '198.51.100.3' } });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);

    clock += 1_500;
    expect((await send()).status).toBe(200);
  });

  it('gives authentication a tighter budget than commands', () => {
    // The only endpoint where guessing repeatedly *is* the attack.
    expect(AUTH_LIMIT.limit).toBeLessThan(COMMAND_LIMIT.limit);
  });
});
