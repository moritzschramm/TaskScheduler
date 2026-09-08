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

  /** A sign-in attempt from a caller the proxy reports as `ip`. */
  const signInFrom = async (headers: Record<string, string>): Promise<number> =>
    (
      await app.app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ email: 'nobody@example.test', password: 'not-the-one' }),
      })
    ).status;

  it('counts each caller separately', async () => {
    // `x-real-ip` is what nginx assigns from the peer address, so it is what
    // distinguishes two callers — a limiter keyed on anything shared would
    // punish everybody for one.
    const from = (ip: string) => signInFrom({ 'x-real-ip': ip });

    for (let attempt = 0; attempt < AUTH_LIMIT.limit; attempt += 1) await from('198.51.100.7');

    expect(await from('198.51.100.7')).toBe(429);
    expect(await from('203.0.113.9')).toBe(401);
  });

  /**
   * The bypass this limiter shipped with.
   *
   * nginx *appends* to `x-forwarded-for`, so its leftmost entry is whatever the
   * caller wrote. Keying on it meant a new bucket per request and no effective
   * limit on the one endpoint where guessing repeatedly is the attack. The
   * assertion is the one that was missing: a caller who changes their story
   * every time must still run out.
   */
  it('cannot be escaped by rewriting x-forwarded-for', async () => {
    const attempt = (claimed: string) =>
      signInFrom({
        // What nginx would hand over: the caller's claim, then the real peer.
        'x-forwarded-for': `${claimed}, 198.51.100.7`,
        'x-real-ip': '198.51.100.7',
      });

    for (let index = 0; index < AUTH_LIMIT.limit; index += 1) {
      await attempt(`203.0.113.${index}`);
    }

    expect(await attempt('203.0.113.200')).toBe(429);
  });

  /**
   * Without `x-real-ip` — a proxy that sets only the one header — the rightmost
   * hop is the trustworthy one, for the same reason.
   */
  it('reads the hop the proxy appended, not the one the caller claimed', async () => {
    const attempt = (claimed: string) =>
      signInFrom({ 'x-forwarded-for': `${claimed}, 198.51.100.8` });

    for (let index = 0; index < AUTH_LIMIT.limit; index += 1) {
      await attempt(`203.0.113.${index}`);
    }

    expect(await attempt('203.0.113.201')).toBe(429);
    // A genuinely different peer is still its own bucket.
    expect(await signInFrom({ 'x-forwarded-for': '203.0.113.5, 198.51.100.9' })).toBe(401);
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
