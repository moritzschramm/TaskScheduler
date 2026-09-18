import { hc } from 'hono/client';
import type { AppType } from '@ambitime/server';

/**
 * Typed RPC client over the Hono app (spec §3.1: one typed client/server
 * contract). `@ambitime/server` is a type-only dependency — nothing from the
 * server's runtime is bundled into the client.
 *
 * Requests go to the same origin: nginx proxies `/api` to the server in both
 * dev and prod, so there is no cross-origin configuration to keep in sync.
 */
export const api = hc<AppType>('/');

/** A refusal from the API, carrying the sentence the server wrote for a person. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set only on 429 — see `retryAfterSeconds`. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The status §14's limiter answers with. Named because three call sites test it. */
export const RATE_LIMITED = 429;

/**
 * How long a rate-limited caller has to wait, in seconds.
 *
 * **Two headers, because there are two limiters.** §14's own middleware sets
 * the standard `Retry-After`; Better Auth's built-in limiter — which is on by
 * default in production and guards `/api/auth/*` with its own stricter rules —
 * sets `X-Retry-After` instead. A client that read only one of them would tell
 * the truth on some routes and shrug on others.
 *
 * `null` means the server refused without saying for how long, which is a
 * weaker answer but still a different one from "your password is wrong".
 */
export function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after') ?? response.headers.get('x-retry-after');
  if (header === null) return null;

  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * What to show somebody the limiter has stopped.
 *
 * The wait is worth stating: a refusal with no horizon reads as "broken", and
 * the reaction to broken is to retry immediately, which is the one thing that
 * keeps the window from closing.
 */
export function rateLimitMessage(response: Response): string {
  const seconds = retryAfterSeconds(response);
  return seconds === null
    ? 'Too many attempts. Wait a moment and try again.'
    : `Too many attempts. Try again in ${describeWait(seconds)}.`;
}

/** Seconds, in units a person waits in. "3600 seconds" is not an answer. */
function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The parsed body of a successful response, or a thrown `ApiError`.
 *
 * The message is the server's own: the command layer phrases its refusals for
 * the person who will read them — "An activity type called Work already exists" — and
 * replacing that with a generic string at this boundary would throw away the
 * only part of the failure a user can act on (§6.7).
 */
export async function expectOk(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.ok) return body;

  const message =
    typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: { message?: string } }).error.message ?? response.statusText)
      : response.statusText;

  throw new ApiError(response.status, message, retryAfterSeconds(response));
}
