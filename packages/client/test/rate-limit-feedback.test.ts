import { describe, expect, it, vi, afterEach } from 'vitest';
import { rateLimitMessage, retryAfterSeconds } from '@/lib/api';
import { requestPasswordReset, resetPassword, signIn, signUp } from '@/lib/session';

/**
 * What a refused-for-volume request looks like to a person (spec §14).
 *
 * **The bug this is written against told people their password was wrong.**
 * `signIn` mapped every unsuccessful response to "those details did not match
 * an account", which is true of a 401 and a lie about a 429 — and it is a lie
 * told at the worst possible moment, to somebody who has just typed the right
 * password and whose natural response is to type it again and stay locked out.
 *
 * So the order of the checks in each of these functions is the behaviour, and
 * these tests are about that order.
 */
function limited(headers: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests.' } }),
        { status: 429, headers },
      ),
  );
}

afterEach(() => void vi.unstubAllGlobals());

describe('reading the limiter', () => {
  it('takes the standard header', () => {
    const response = new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    expect(retryAfterSeconds(response)).toBe(30);
  });

  it('takes Better Auth’s header too', () => {
    // Two limiters guard `/api/auth/*`: §14's middleware, which sets
    // `Retry-After`, and the library's own — on by default in production —
    // which sets `X-Retry-After`. Reading one would be right on some routes.
    const response = new Response(null, { status: 429, headers: { 'x-retry-after': '30' } });
    expect(retryAfterSeconds(response)).toBe(30);
  });

  it('survives a server that said nothing', () => {
    const silent = new Response(null, { status: 429 });
    expect(retryAfterSeconds(silent)).toBeNull();
    // Still a different answer from "your password is wrong", which is the
    // part that matters.
    expect(rateLimitMessage(silent)).toContain('Too many attempts');
  });

  it('counts in units somebody waits in', () => {
    const inSeconds = new Response(null, { status: 429, headers: { 'retry-after': '45' } });
    expect(rateLimitMessage(inSeconds)).toContain('45 seconds');

    // "Try again in 3600 seconds" is arithmetic homework, not an answer.
    const inAnHour = new Response(null, { status: 429, headers: { 'retry-after': '3600' } });
    expect(rateLimitMessage(inAnHour)).toContain('60 minutes');

    const one = new Response(null, { status: 429, headers: { 'retry-after': '1' } });
    expect(rateLimitMessage(one)).toContain('1 second');
    expect(rateLimitMessage(one)).not.toContain('1 seconds');
  });

  it('ignores a header that is not a number', () => {
    // `Retry-After` also permits an HTTP date, which this does not read. A
    // wrong number would be worse than no number.
    const dated = new Response(null, {
      status: 429,
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });
    expect(retryAfterSeconds(dated)).toBeNull();
  });
});

describe('every form that can be limited says so', () => {
  it('sign in', async () => {
    limited({ 'retry-after': '45' });

    const message = await signIn('ada@example.test', 'correct-horse-battery');
    expect(message).toContain('Too many attempts');
    expect(message).toContain('45 seconds');
    // The regression, named: this must not be reported as bad credentials.
    expect(message).not.toContain('did not match');
  });

  it('sign up', async () => {
    limited({ 'retry-after': '20' });

    const message = await signUp('ada@example.test', 'correct-horse-battery', 'Ada');
    expect(message).toContain('Too many attempts');
    expect(message).not.toContain('could not be created');
  });

  it('asking for a reset link', async () => {
    limited({ 'retry-after': '20' });

    const message = await requestPasswordReset('ada@example.test');
    expect(message).toContain('Too many attempts');
  });

  it('setting the new password', async () => {
    limited({ 'retry-after': '20' });

    const message = await resetPassword('a-token', 'a-brand-new-passphrase');
    expect(message).toContain('Too many attempts');
    // And not "that link has expired", which would send somebody round the
    // whole loop again to be refused in exactly the same way.
    expect(message).not.toContain('expired');
  });
});

describe('sign-in still blurs what it should', () => {
  it('does not distinguish a missing account from a wrong password', async () => {
    for (const status of [401, 404]) {
      vi.stubGlobal(
        'fetch',
        async () => new Response(JSON.stringify({ code: 'INVALID_EMAIL_OR_PASSWORD' }), { status }),
      );
      expect(await signIn('ada@example.test', 'guess')).toBe(
        'Those details did not match an account',
      );
    }
  });

  it('but does say when the address is merely unconfirmed', async () => {
    // Only reachable where the deployment requires verification. Whoever sees
    // this has already supplied the right password, so the existence of the
    // account is not news to them — and which door is shut is.
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ code: 'EMAIL_NOT_VERIFIED' }), { status: 403 }),
    );

    const message = await signIn('ada@example.test', 'correct-horse-battery');
    expect(message).toContain('Confirm your email');
  });
});
