import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditResponseSchema } from '@ambitime/shared';
import { pruneAudit } from '../../src/audit/read.js';
import { withSystemPrivileges } from '../../src/db/context.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import { AUTH_LIMIT, COMMAND_LIMIT, rateLimit } from '../../src/api/rate-limit.js';
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

  it('counts what each command touched without shipping the row images', async () => {
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

    // A create writes the task and its occurrence, so more than one row —
    // counted rather than listed, because the images are what undo runs on and
    // an audit answers "how much did this touch".
    expect(latest!.changed).toBeGreaterThan(1);
    expect(latest!.calendarIds).toContain(world.calendarId);
    expect(JSON.stringify(latest)).not.toContain('"before"');
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
