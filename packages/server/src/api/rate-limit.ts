import type { MiddlewareHandler } from 'hono';

/**
 * Rate limiting (spec §14's security baselines).
 *
 * A fixed-window counter, in memory, keyed by client and route class. The
 * shape is deliberately modest and its limits are worth stating plainly:
 *
 * - **In memory**, so each process counts its own. Behind two replicas the
 *   effective limit is twice what is configured. Moving the counter to Redis or
 *   to Postgres is a change of one function, and until there are two replicas
 *   it would be a dependency bought for nothing.
 * - **Fixed window** rather than sliding, so a caller can spend a full window's
 *   budget at the end of one and again at the start of the next. That matters
 *   for a limiter defending a login form and not for one defending a command
 *   endpoint from a runaway client, which is what this is.
 *
 * What it is *for* is the honest question. It is not a defence against a
 * determined attacker — that belongs at the proxy (§14 names nginx) — but
 * against a loop in a client, a stuck retry, and credential stuffing slow
 * enough to look like traffic.
 */
export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

/** Writes are cheap but each one re-derives a fortnight; be less generous. */
export const COMMAND_LIMIT: RateLimit = { limit: 120, windowMs: 60_000 };

/** Reads are cheap and a busy client makes several per view. */
export const READ_LIMIT: RateLimit = { limit: 600, windowMs: 60_000 };

/**
 * Authentication is the one worth being strict about: it is the only endpoint
 * where guessing repeatedly is the attack.
 */
export const AUTH_LIMIT: RateLimit = { limit: 20, windowMs: 60_000 };

/**
 * The assistant (spec §2.2), which is the only route that spends money.
 *
 * Twenty a minute is far more than a person types and far less than a loop
 * costs. The ceiling here is not the server's — it is somebody's bill with a
 * provider, and the failure this guards against is a client bug rather than an
 * attacker: a retry that re-sends the last turn, or an auto-continue that never
 * decides it is finished.
 */
export const ASSISTANT_LIMIT: RateLimit = { limit: 20, windowMs: 60_000 };

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions extends RateLimit {
  /** Distinguishes one caller from another. Defaults to the client address. */
  key?: (context: Parameters<MiddlewareHandler>[0]) => string;
  now?: () => number;
}

/**
 * A limiter for one class of route.
 *
 * Each returns its own middleware with its own counters, so a client exhausting
 * its command budget can still read — one runaway loop should not black out the
 * whole application for the person running it.
 */
export function rateLimit({
  limit,
  windowMs,
  key = defaultKey,
  now = Date.now,
}: RateLimiterOptions): MiddlewareHandler {
  const windows = new Map<string, Window>();

  return async (c, next) => {
    const at = now();
    const id = key(c);
    const window = windows.get(id);

    if (window === undefined || window.resetAt <= at) {
      // Swept here rather than on a timer: the map only grows while requests
      // arrive, and an idle process should not hold a job open to tidy it.
      if (windows.size > 10_000) {
        for (const [existing, value] of windows) {
          if (value.resetAt <= at) windows.delete(existing);
        }
      }
      windows.set(id, { count: 1, resetAt: at + windowMs });
      return next();
    }

    window.count += 1;

    if (window.count > limit) {
      const retryAfter = Math.ceil((window.resetAt - at) / 1000);
      c.header('Retry-After', String(retryAfter));

      // 429 with the API's own error shape, so a client handles it the way it
      // handles every other refusal rather than by guessing at a bare status.
      return c.json(
        {
          error: {
            code: 'rate_limited' as const,
            message: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
          },
        },
        429,
      );
    }

    return next();
  };
}

/**
 * The client address, as the *proxy* reports it — never as the client claims it.
 *
 * **This was a rate-limit bypass, and the auth limiter is what it bypassed.**
 * The previous version read the leftmost entry of `x-forwarded-for`. nginx
 * builds that header with `$proxy_add_x_forwarded_for`, which *appends* the
 * peer address to whatever arrived — so the leftmost entry is a value the
 * caller wrote. Sending a different one on each request produced a different
 * bucket every time, and twenty-attempts-per-minute on `/auth/*` became
 * unlimited: exactly the credential-stuffing case the limit exists for.
 *
 * Two sources, in order of how hard they are to forge:
 *
 *  1. **`x-real-ip`**, which nginx sets with `proxy_set_header X-Real-IP
 *     $remote_addr` — an assignment, so anything the client sent is discarded
 *     before the server sees it.
 *  2. The **rightmost** `x-forwarded-for` entry, which is the one the nearest
 *     trusted proxy appended. Everything to its left came from further out and
 *     is only as trustworthy as the hop that wrote it.
 *
 * Both assume the server is reached through the proxy. A deployment that
 * publishes the server's port directly gives every caller free choice of both
 * headers, and no in-process limiter can help it — see `docs/operations.md`.
 */
function defaultKey(c: Parameters<MiddlewareHandler>[0]): string {
  const real = c.req.header('x-real-ip')?.trim();
  if (real !== undefined && real !== '') return real;

  const forwarded = c.req.header('x-forwarded-for') ?? '';
  const hops = forwarded
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');

  // A single shared bucket rather than no limit at all, when there is nothing
  // to key on: over-restricting an unproxied deployment beats not limiting it.
  return hops.at(-1) ?? 'unknown';
}
