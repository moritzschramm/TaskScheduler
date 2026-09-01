import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_LIMIT, COMMAND_LIMIT, rateLimit } from '../../src/api/rate-limit.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createTestApp, type TestApp } from '../support/auth.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Rate limiting (spec §14), through the app rather than around it.
 *
 * **This file exists because the unit tests it would have been easier to write
 * would all have passed.** `rateLimit()` counted correctly from the day it was
 * written; what was wrong was where it was mounted — `app.use('/api/auth/*')`
 * on an app already based at `/api` registers `/api/api/auth/*`, which nothing
 * can request. Every limiter in the application matched no route at all, and
 * did so invisibly, because nothing ever asked whether a limit could be
 * *reached* by the path a client actually calls.
 *
 * So the assertions below go through `app.request` at real paths. A limiter
 * tested in isolation is a counter with opinions; only the route proves it
 * defends anything.
 */
describe('rate limiting', () => {
  let handle: DatabaseHandle;
  let app: TestApp;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    // A fresh app each time, so one test's budget is not another's. The
    // counters live in the middleware closure, which is built with the app.
    app = createTestApp(handle.db);
  });

  /** Wrong credentials on purpose: what a limiter is for is the guessing. */
  const attemptSignIn = async (): Promise<Response> =>
    app.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'not-the-one' }),
    });

  it('stops guessing at the sign-in endpoint', async () => {
    for (let attempt = 0; attempt < AUTH_LIMIT.limit; attempt += 1) {
      // Refused, but on the merits — the limiter has not spoken yet.
      expect((await attemptSignIn()).status).toBe(401);
    }

    expect((await attemptSignIn()).status).toBe(429);
  });

  it('says how long to wait, in the shape every other refusal uses', async () => {
    for (let attempt = 0; attempt < AUTH_LIMIT.limit; attempt += 1) await attemptSignIn();

    const limited = await attemptSignIn();

    // A client that can read `Retry-After` should not have to parse prose.
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(AUTH_LIMIT.windowMs / 1000);

    // And one that cannot should still get a sentence rather than a bare 429.
    expect(await limited.json()).toMatchObject({
      error: { code: 'rate_limited', message: expect.stringContaining('Try again in') },
    });
  });

  it('keeps a signed-in user reading after they exhaust the write budget', async () => {
    const session = await app.signUp({ email: 'busy@example.test' });

    // §14's classes are separate counters, and this is the promise that buys:
    // a runaway client should not black out the application for the person
    // running it.
    for (let write = 0; write <= COMMAND_LIMIT.limit; write += 1) {
      await app.as(session, '/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
    }

    const spent = await app.as(session, '/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(spent.status).toBe(429);

    expect((await app.as(session, '/api/me')).status).toBe(200);
  });

  it('counts each caller separately', async () => {
    // The proxy's header is what distinguishes them (§14 puts nginx in front),
    // so a limiter keyed on anything else would punish everybody for one.
    const from = async (ip: string): Promise<number> =>
      (
        await app.app.request('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ email: 'nobody@example.test', password: 'not-the-one' }),
        })
      ).status;

    for (let attempt = 0; attempt < AUTH_LIMIT.limit; attempt += 1) await from('198.51.100.7');

    expect(await from('198.51.100.7')).toBe(429);
    expect(await from('203.0.113.9')).toBe(401);
  });

  it('lets the window pass', async () => {
    // Fixed-window, so this is the documented shape rather than a leak: the
    // budget returns all at once when the window turns over.
    let now = 1_000_000;
    const limited = rateLimit({ limit: 1, windowMs: 60_000, now: () => now });
    const app = new (await import('hono')).Hono();
    app.use('/*', limited);
    app.get('/thing', (c) => c.json({ ok: true }));

    expect((await app.request('/thing')).status).toBe(200);
    expect((await app.request('/thing')).status).toBe(429);

    now += 60_001;
    expect((await app.request('/thing')).status).toBe(200);
  });
});
