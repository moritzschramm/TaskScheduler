import { readonly, ref } from 'vue';
import { api, RATE_LIMITED, rateLimitMessage } from './api';

/**
 * Who is signed in, and where they are acting (spec §9.3, §10.1).
 *
 * A module-level singleton rather than a store: there is exactly one session
 * per page, the router guard and the shell both need it, and a state library
 * for one object would be ceremony. If M12's optimistic scheduling needs more
 * shared state than this, that is the moment to reach for Pinia — not now.
 *
 * Nothing here holds a token. The session lives in an HttpOnly cookie the
 * browser attaches on its own (§10.1), which is why signing in is a request
 * whose *body* we discard and whose effect is entirely in the response headers.
 */

export interface SessionContext {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
  isPersonal: boolean;
}

/**
 * Spec §13's display settings.
 *
 * All nullable, and `null` means *unset* rather than a default: a user who has
 * never opened settings sees exactly what they saw before settings existed.
 * Every fallback is decided at the point of use, where the alternative is
 * known — the calendar's own zone, or the browser's locale.
 */
export interface DisplaySettings {
  locale: string | null;
  timeZone: string | null;
  firstDayOfWeek: number | null;
}

export interface Session {
  user: { id: string; email: string; displayName: string | null; emailVerified: boolean };
  settings: DisplaySettings;
  activeTenantId: string;
  contexts: SessionContext[];
}

/**
 * The locale to format in.
 *
 * Falls back to the browser's rather than to a hard-coded `en-GB`: somebody who
 * has not chosen is better served by their operating system's answer than by
 * this application's guess.
 */
export function displayLocale(): string {
  return current.value?.settings.locale ?? navigator.language ?? 'en-GB';
}

/**
 * The zone to draw a calendar in (§13, §5.1).
 *
 * §13 says display respects the user's timezone; §5.1 makes a calendar's own
 * zone the one its wall-clock rules mean. Both are true and they answer
 * different questions — so the user's setting wins when they have made one, and
 * the calendar's is the fallback, which is what every screen did before this
 * setting existed.
 *
 * A viewer in Lisbon who has set nothing keeps seeing the Berlin working day
 * they were shown yesterday; one who has set Europe/Lisbon sees their own.
 */
export function displayTimeZone(calendarTimeZone: string): string {
  return current.value?.settings.timeZone ?? calendarTimeZone;
}

/** ISO weekday the week starts on. Display only — see the settings handler. */
export function displayFirstDayOfWeek(): number {
  return current.value?.settings.firstDayOfWeek ?? 1;
}

const current = ref<Session | null>(null);
const resolved = ref(false);

export const session = readonly(current);
export const sessionResolved = readonly(resolved);

/**
 * Asks the server who we are.
 *
 * Returns `null` for "not signed in" rather than throwing, because that is not
 * an error — it is the answer, and the router acts on it.
 */
export async function loadSession(): Promise<Session | null> {
  const response = await api.api.me.$get();

  current.value = response.status === 200 ? ((await response.json()) as Session) : null;
  resolved.value = true;

  return current.value;
}

/**
 * Where a link mailed by the server comes back to.
 *
 * The client owns these because they are its route table, and it sends them
 * with the request that causes the email — Better Auth has no way to know what
 * the application's URLs are. They live here rather than in the router because
 * the router is where they are *served* and this is where they are *promised*;
 * `router.ts` imports them so the two cannot drift apart.
 */
export const RESET_PASSWORD_PATH = '/reset-password';
export const VERIFY_EMAIL_PATH = '/verify-email';

/**
 * A call to Better Auth.
 *
 * Not the `hc` RPC client: these routes are the library's rather than the
 * app's, so they are outside `AppType` and there is no contract to inherit.
 * `same-origin` credentials are what carry the session cookie back (§10.1).
 */
async function authRequest(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
}

/**
 * Creating an account (spec §10.1).
 *
 * Better Auth writes the `users` row and M1's triggers do the rest: the
 * personal tenant, its `owner` membership and the primary email identity all
 * appear without sign-up knowing any of them exist (§4.2). It also signs the
 * new user in, so there is no second step.
 *
 * **The error wording is not blurred here, unlike `signIn`.** Sign-in refuses
 * to say whether an address exists, because telling someone which half they got
 * right is a gift to whoever is guessing. Sign-up cannot keep that secret and
 * still be usable: somebody whose address is already registered has to be told
 * so, or they cannot get in. The blur would also be theatre — a sign-up form
 * reveals existence by succeeding or failing whatever it says.
 *
 * Closing that properly means not answering at the form at all: accept the
 * address, send a message to it, and say "check your email" either way. That
 * needs a working transport, and M15b's is an adapter that logs.
 */
export async function signUp(
  email: string,
  password: string,
  displayName: string,
): Promise<string | null> {
  const response = await authRequest('sign-up/email', {
    email,
    password,
    name: displayName,
    // Where the confirmation link lands. Better Auth validates this against
    // the trusted origins before it puts it in an email, which is what stops
    // a crafted sign-up from mailing somebody a link to somewhere else.
    callbackURL: VERIFY_EMAIL_PATH,
  });

  if (response.status === RATE_LIMITED) return rateLimitMessage(response);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null;
    return signUpMessage(body?.code);
  }

  // The response carries a session cookie, so the new account is already signed
  // in; this is what puts it in front of the router guard.
  await loadSession();
  return null;
}

/**
 * The server's codes, in words a person can act on.
 *
 * Mapped rather than passed through: Better Auth writes for a developer
 * reading a response, and "User already exists. Use another email." is an
 * instruction to do the one thing that is probably wrong.
 */
function signUpMessage(code: string | undefined): string {
  switch (code) {
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'There is already an account with that address. Try signing in instead.';
    case 'PASSWORD_TOO_SHORT':
      return `Passwords need at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
    case 'INVALID_EMAIL':
      return 'That does not look like an email address.';
    default:
      return 'That account could not be created';
  }
}

/** Better Auth's own minimum, repeated here so the form can say it up front. */
export const MINIMUM_PASSWORD_LENGTH = 8;

export async function signIn(email: string, password: string): Promise<string | null> {
  const response = await authRequest('sign-in/email', { email, password });

  // Checked before the blur below, and this order is the whole point. A
  // limiter's refusal used to be reported as "those details did not match an
  // account" — telling somebody with the right password that it is wrong, at
  // the exact moment they are most likely to retype it and stay locked out.
  if (response.status === RATE_LIMITED) return rateLimitMessage(response);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null;

    // Only reachable where the deployment requires verification. Somebody who
    // has already given the right password learns nothing from being told the
    // account exists, and everything from being told which door is shut.
    if (body?.code === 'EMAIL_NOT_VERIFIED') {
      return 'Confirm your email address first. Check your inbox for the link we sent.';
    }

    // Deliberately not the server's wording. "No account with that address"
    // and "wrong password" are the same message here, because distinguishing
    // them tells someone which half they got right.
    return 'Those details did not match an account';
  }

  await loadSession();
  return null;
}

/**
 * Asking for a reset link (spec §10.1).
 *
 * **This one can keep the secret the sign-up form cannot.** The server answers
 * the same way whether or not the address has an account, and the callback that
 * writes the email is simply not reached for one that does not — so "if that
 * address has an account, a link is on its way" is a description of what
 * happened rather than a form of words.
 *
 * Which is why it returns `null` for both. There is no failure here to report
 * except the network and the limiter.
 */
export async function requestPasswordReset(email: string): Promise<string | null> {
  const response = await authRequest('request-password-reset', {
    email,
    redirectTo: RESET_PASSWORD_PATH,
  });

  if (response.status === RATE_LIMITED) return rateLimitMessage(response);
  if (!response.ok) return 'That link could not be sent. Try again in a moment.';
  return null;
}

/**
 * Redeeming one (spec §10.1).
 *
 * The token arrives in the query string, put there by Better Auth's own
 * redirect after it has checked the token is real and unexpired — so a link
 * that was forged, spent or stale never reaches this form. Every session the
 * account had ends here as well; see `revokeSessionsOnPasswordReset`.
 */
export async function resetPassword(token: string, newPassword: string): Promise<string | null> {
  const response = await authRequest('reset-password', { token, newPassword });

  if (response.status === RATE_LIMITED) return rateLimitMessage(response);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null;
    return resetMessage(body?.code);
  }

  return null;
}

function resetMessage(code: string | undefined): string {
  switch (code) {
    case 'INVALID_TOKEN':
      return 'That link has expired or has already been used. Ask for a new one.';
    case 'PASSWORD_TOO_SHORT':
      return `Passwords need at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
    case 'PASSWORD_TOO_LONG':
      return 'That password is too long.';
    default:
      return 'That password could not be changed. Ask for a new link and try again.';
  }
}

/**
 * Sending the confirmation again (spec §10.1).
 *
 * Wanted more often than it sounds: the first one is sent while somebody is
 * still typing their address, so the commonest reason to need a second is that
 * the first went to a mistyped version of the right one.
 *
 * Signed out, the endpoint answers identically for an unknown address, an
 * already-confirmed one and a fresh send — including a floor on how long it
 * takes, so the wait does not give the answer away either.
 */
export async function resendVerification(email: string): Promise<string | null> {
  const response = await authRequest('send-verification-email', {
    email,
    callbackURL: VERIFY_EMAIL_PATH,
  });

  if (response.status === RATE_LIMITED) return rateLimitMessage(response);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null;
    // Signed *in*, the server does distinguish these; there is no one to hide
    // them from, since the asker is the account.
    if (body?.code === 'EMAIL_ALREADY_VERIFIED') return 'That address is already confirmed.';
    return 'That message could not be sent. Try again in a moment.';
  }

  return null;
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
  current.value = null;
}

/**
 * The presence heartbeat (spec §11).
 *
 * What decides whether the next notification arrives in the app or by email.
 * Sent while a signed-in page is open and stopped when it is not — a tab left
 * open in a browser that has been closed is not a person who is present, and
 * `PRESENCE_TIMEOUT_MINUTES` on the server is what makes a missed beat mean
 * absent rather than a dropped request mean absent.
 *
 * Failures are swallowed on purpose. A heartbeat that could not be sent is a
 * heartbeat that did not happen, which is exactly what the server should
 * conclude; showing the user an error about it would be reporting a problem
 * they neither caused nor can fix.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

let heartbeat: ReturnType<typeof setInterval> | undefined;

export function startHeartbeat(): void {
  if (heartbeat !== undefined) return;

  const beat = () => {
    void api.api.presence.$post().catch(() => undefined);
  };

  beat();
  heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (heartbeat === undefined) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}
