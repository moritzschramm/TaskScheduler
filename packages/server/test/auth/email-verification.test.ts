import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuth } from '../../src/auth/auth.js';
import { EMAIL_VERIFICATION_TTL_MINUTES } from '../../src/auth/emails.js';
import { recordingEmailSender } from '../../src/notifications/email.js';
import { users } from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { TEST_AUTH_SECRET, TEST_BASE_URL, TEST_PASSWORD } from '../support/auth.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Confirming an address (spec §10.1, §11).
 *
 * §11 sends warnings to this address when the user is offline, so whether it
 * is real is not bookkeeping — it is whether the whole notification channel
 * exists for that person. That is what makes the flag worth setting and worth
 * being careful about setting.
 */
describe('confirming an email address', () => {
  let handle: DatabaseHandle;
  let email: ReturnType<typeof recordingEmailSender>;

  const build = (requireEmailVerification = false): ReturnType<typeof createApp> =>
    createApp({
      db: handle.db,
      auth: createAuth({
        db: handle.db,
        secret: TEST_AUTH_SECRET,
        baseURL: TEST_BASE_URL,
        email,
        requireEmailVerification,
      }),
      requestLogging: false,
    });

  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    email = recordingEmailSender();
    app = build();
  });

  const post = async (
    target: ReturnType<typeof createApp>,
    path: string,
    body: unknown,
    cookie?: string,
  ): Promise<Response> =>
    target.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
      body: JSON.stringify(body),
    });

  const signUp = async (
    target: ReturnType<typeof createApp>,
    address: string,
  ): Promise<{ cookie: string; status: number }> => {
    const response = await post(target, '/api/auth/sign-up/email', {
      email: address,
      password: TEST_PASSWORD,
      name: 'Ada',
      callbackURL: '/verify-email',
    });
    return {
      status: response.status,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };

  /** The link out of the last message, followed as a mail client would. */
  const follow = async (
    target: ReturnType<typeof createApp>,
    cookie?: string,
  ): Promise<Response> => {
    const link = /https?:\/\/\S+/.exec(email.sent.at(-1)?.body ?? '')?.[0];
    expect(link).toBeDefined();

    const url = new URL(link!);
    return target.request(url.pathname + url.search, {
      redirect: 'manual',
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
  };

  const verifiedFlag = async (address: string): Promise<boolean | undefined> => {
    const [user] = await handle.db
      .select({ verified: users.emailVerified })
      .from(users)
      .where(eq(users.email, address));
    return user?.verified;
  };

  it('sends the link at sign-up, before anybody has to ask', async () => {
    await signUp(app, 'ada@example.test');

    const [message] = email.sent;
    expect(message?.to).toBe('ada@example.test');
    expect(message?.subject).toContain('confirm your email address');
    // Sent unprompted, so the lifetime is generous and the message says which.
    expect(message?.body).toContain('one day');
    expect(EMAIL_VERIFICATION_TTL_MINUTES).toBe(60 * 24);

    // §11's reason for caring, said in the message rather than assumed.
    expect(message?.body).toContain('due date');
  });

  it('starts unconfirmed and ends confirmed', async () => {
    const { cookie } = await signUp(app, 'ada@example.test');
    expect(await verifiedFlag('ada@example.test')).toBe(false);

    const followed = await follow(app, cookie);
    expect(followed.status).toBe(302);
    // Lands on the client route that reports it, not on a bare JSON body.
    expect(new URL(followed.headers.get('location')!, TEST_BASE_URL).pathname).toBe(
      '/verify-email',
    );

    expect(await verifiedFlag('ada@example.test')).toBe(true);
  });

  it('tells the client, so the banner can go away', async () => {
    const { cookie } = await signUp(app, 'ada@example.test');

    const before = (await app.request('/api/me', { headers: { cookie } })).json();
    expect(await before).toMatchObject({ user: { emailVerified: false } });

    await follow(app, cookie);

    const after = (await app.request('/api/me', { headers: { cookie } })).json();
    expect(await after).toMatchObject({ user: { emailVerified: true } });
  });

  it('sends the reader in with a session, from any browser', async () => {
    // The commonest way to read the mail is not the browser that signed up.
    // Refusing to act on the link and then asking for a password would be
    // ceremony: the link is a bearer proof for that address either way.
    await signUp(app, 'ada@example.test');

    const followed = await follow(app);
    expect(followed.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it('reports a dead link to the same page rather than erroring', async () => {
    await signUp(app, 'ada@example.test');

    const response = await app.request(
      '/api/auth/verify-email?token=not-a-real-token&callbackURL=%2Fverify-email',
      { redirect: 'manual' },
    );
    const landing = new URL(response.headers.get('location')!, TEST_BASE_URL);

    // What the client's failure branch is written against.
    expect(landing.pathname).toBe('/verify-email');
    expect(landing.searchParams.get('error')).toBe('INVALID_TOKEN');
    expect(await verifiedFlag('ada@example.test')).toBe(false);
  });

  it('sends another when asked', async () => {
    const { cookie } = await signUp(app, 'ada@example.test');
    expect(email.sent).toHaveLength(1);

    // The commonest reason to need a second is that the first went to a
    // mistyped version of the right address.
    const resent = await post(
      app,
      '/api/auth/send-verification-email',
      { email: 'ada@example.test', callbackURL: '/verify-email' },
      cookie,
    );

    expect(resent.status).toBe(200);
    expect(email.sent).toHaveLength(2);
    expect(email.sent[1]?.to).toBe('ada@example.test');

    // What makes the second message worth sending is that it works. It may
    // well carry the same token as the first — the link is a signed claim
    // about an address and a second, not a nonce — and that is fine; what
    // would not be fine is a resend that produced a link leading nowhere.
    expect((await follow(app, cookie)).status).toBe(302);
    expect(await verifiedFlag('ada@example.test')).toBe(true);
  });

  it('will not resend for somebody else', async () => {
    const { cookie } = await signUp(app, 'ada@example.test');
    await signUp(app, 'grace@example.test');
    email.sent.length = 0;

    // A signed-in session may ask for its own address and no other, or the
    // endpoint would mail anybody on request.
    const response = await post(
      app,
      '/api/auth/send-verification-email',
      { email: 'grace@example.test', callbackURL: '/verify-email' },
      cookie,
    );

    expect(response.status).toBe(400);
    expect(email.sent).toEqual([]);
  });

  it('keeps the door shut when the deployment asks it to', async () => {
    // The opt-in `REQUIRE_EMAIL_VERIFICATION` path. Off by default because the
    // stock transport only logs, so requiring it out of the box would be an
    // install nobody can sign in to.
    const strict = build(true);
    await signUp(strict, 'ada@example.test');

    const refused = await post(strict, '/api/auth/sign-in/email', {
      email: 'ada@example.test',
      password: TEST_PASSWORD,
    });
    expect(refused.status).toBe(403);
    // The code the client turns into "confirm your email address first".
    expect(await refused.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    await follow(strict);

    const allowed = await post(strict, '/api/auth/sign-in/email', {
      email: 'ada@example.test',
      password: TEST_PASSWORD,
    });
    expect(allowed.status).toBe(200);
  });
});
