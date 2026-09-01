import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuth } from '../../src/auth/auth.js';
import { PASSWORD_RESET_TTL_MINUTES } from '../../src/auth/emails.js';
import { recordingEmailSender } from '../../src/notifications/email.js';
import { users } from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { TEST_AUTH_SECRET, TEST_BASE_URL, TEST_PASSWORD } from '../support/auth.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Forgotten passwords (spec §10.1).
 *
 * The mechanism is a link mailed to an address, so the message *is* the
 * interface — which is why these assertions read it rather than reaching for
 * the token in the database. A reset flow that works only when you already
 * know the token is a reset flow nobody can use.
 */
describe('resetting a password', () => {
  let handle: DatabaseHandle;
  let email: ReturnType<typeof recordingEmailSender>;
  let app: ReturnType<typeof createApp>;

  const NEW_PASSWORD = 'a-brand-new-passphrase';

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    email = recordingEmailSender();
    app = createApp({
      db: handle.db,
      auth: createAuth({
        db: handle.db,
        secret: TEST_AUTH_SECRET,
        baseURL: TEST_BASE_URL,
        email,
      }),
      requestLogging: false,
    });
  });

  const post = async (path: string, body: unknown, cookie?: string): Promise<Response> =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
      body: JSON.stringify(body),
    });

  const signUp = async (address: string): Promise<string> => {
    const response = await post('/api/auth/sign-up/email', {
      email: address,
      password: TEST_PASSWORD,
      name: 'Ada',
    });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    email.sent.length = 0; // The verification mail; not what this file is about.
    return cookie;
  };

  /** Follows the link out of the message, exactly as a mail client would. */
  const followResetLink = async (): Promise<URL> => {
    const link = /https?:\/\/\S+/.exec(email.sent.at(-1)?.body ?? '')?.[0];
    expect(link).toBeDefined();

    const response = await app.request(new URL(link!).pathname + new URL(link!).search, {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location')!, TEST_BASE_URL);
  };

  it('emails a link that leads to the form', async () => {
    await signUp('ada@example.test');

    const asked = await post('/api/auth/request-password-reset', {
      email: 'ada@example.test',
      redirectTo: '/reset-password',
    });
    expect(asked.status).toBe(200);

    const [message] = email.sent;
    expect(message?.to).toBe('ada@example.test');
    expect(message?.subject).toContain('reset your password');
    // The lifetime is promised in the message, and promised from the constant
    // — a deployment that shortens one must not leave the other lying.
    expect(message?.body).toContain('one hour');
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(60);

    const landing = await followResetLink();
    expect(landing.pathname).toBe('/reset-password');
    expect(landing.searchParams.get('token')).toBeTruthy();
  });

  it('answers an unknown address exactly as it answers a real one', async () => {
    await signUp('ada@example.test');

    const real = await post('/api/auth/request-password-reset', {
      email: 'ada@example.test',
      redirectTo: '/reset-password',
    });
    const invented = await post('/api/auth/request-password-reset', {
      email: 'nobody@example.test',
      redirectTo: '/reset-password',
    });

    // Identical down to the body, which is what lets the form say "if that
    // address has an account" and mean it. The only difference is the one that
    // cannot be observed from here: no message was composed for the invented
    // address, so there is nothing to leak.
    expect(invented.status).toBe(real.status);
    expect(await invented.json()).toEqual(await real.json());
    expect(email.sent.map((message) => message.to)).toEqual(['ada@example.test']);
  });

  it('changes the password, and only with the token', async () => {
    await signUp('ada@example.test');
    await post('/api/auth/request-password-reset', {
      email: 'ada@example.test',
      redirectTo: '/reset-password',
    });
    const token = (await followResetLink()).searchParams.get('token');

    expect(
      (await post('/api/auth/reset-password', { token: 'invented', newPassword: NEW_PASSWORD }))
        .status,
    ).toBe(400);

    expect(
      (await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD })).status,
    ).toBe(200);

    expect(
      (
        await post('/api/auth/sign-in/email', {
          email: 'ada@example.test',
          password: TEST_PASSWORD,
        })
      ).status,
    ).toBe(401);
    expect(
      (await post('/api/auth/sign-in/email', { email: 'ada@example.test', password: NEW_PASSWORD }))
        .status,
    ).toBe(200);
  });

  it('spends the token', async () => {
    await signUp('ada@example.test');
    await post('/api/auth/request-password-reset', {
      email: 'ada@example.test',
      redirectTo: '/reset-password',
    });
    const token = (await followResetLink()).searchParams.get('token');

    await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD });

    // A link that has been used is a link somebody else must not be able to
    // use — a forwarded email, a browser history, a proxy log.
    const again = await post('/api/auth/reset-password', {
      token,
      newPassword: 'yet-another-passphrase',
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('refuses a token the link check already rejected', async () => {
    await signUp('ada@example.test');

    // What the client's dead-link branch is written against: the endpoint
    // redirects to the form with `?error=`, never with a token.
    const response = await app.request(
      '/api/auth/reset-password/never-existed?callbackURL=%2Freset-password',
      { redirect: 'manual' },
    );
    const landing = new URL(response.headers.get('location')!, TEST_BASE_URL);

    expect(landing.searchParams.get('error')).toBe('INVALID_TOKEN');
    expect(landing.searchParams.get('token')).toBeNull();
  });

  it('ends every other session', async () => {
    const cookie = await signUp('ada@example.test');
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200);

    await post('/api/auth/request-password-reset', {
      email: 'ada@example.test',
      redirectTo: '/reset-password',
    });
    const token = (await followResetLink()).searchParams.get('token');
    await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD });

    // The usual reason to reset a password is suspecting somebody else has it.
    // A reset that left their session alone would answer the symptom.
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(401);
  });

  /**
   * The landing path travels in the request, because only the client knows its
   * own routes — so what stops a crafted request mailing somebody a link to
   * somewhere else is worth pinning down. Two things do, and only one of them
   * can be asserted here.
   *
   * Better Auth refuses a `redirectTo` outside the trusted origins with a 403,
   * which is the real guard. It cannot be exercised in this suite: the library
   * turns origin checking off when `NODE_ENV` is `test`, which vitest sets, so
   * the request would be allowed here and refused in production — the least
   * useful direction for a test to be wrong in. It was checked against the
   * running stack instead, where a `redirectTo` of `https://evil.example.com`
   * answers `403 INVALID_REDIRECT_URL`.
   *
   * What is true in every environment is below: the address in the message is
   * always this application's own. A hostile `redirectTo` can at most decide
   * where the *second* hop goes, and never where the token is sent.
   */
  it('mails a link to its own origin, whatever it was asked for', async () => {
    await signUp('ada@example.test');

    await post('/api/auth/request-password-reset', {
      email: 'ada@example.test',
      redirectTo: 'https://phishing.example.com/collect',
    });

    const link = /https?:\/\/\S+/.exec(email.sent.at(-1)?.body ?? '')?.[0];
    expect(new URL(link!).origin).toBe(new URL(TEST_BASE_URL).origin);
    expect(link).toContain('/api/auth/reset-password/');
  });

  it('leaves the address confirmed state alone', async () => {
    await signUp('ada@example.test');
    await post('/api/auth/request-password-reset', {
      email: 'ada@example.test',
      redirectTo: '/reset-password',
    });
    const token = (await followResetLink()).searchParams.get('token');
    await post('/api/auth/reset-password', { token, newPassword: NEW_PASSWORD });

    // Reading a mailbox proves control of the address, so it is tempting to
    // count this as verification. It is not what the flag records, and quietly
    // widening what "confirmed" means is how a flag stops meaning anything.
    const [user] = await handle.db
      .select({ verified: users.emailVerified })
      .from(users)
      .where(eq(users.email, 'ada@example.test'));
    expect(user?.verified).toBe(false);
  });
});
