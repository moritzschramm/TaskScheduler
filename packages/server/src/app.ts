import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  ASSISTANT_LIMIT,
  AUTH_LIMIT,
  COMMAND_LIMIT,
  rateLimit,
  READ_LIMIT,
} from './api/rate-limit.js';
import { logger } from 'hono/logger';
import { assistantRoutes } from './routes/assistant.js';
import { authRoutes } from './auth/middleware.js';
import { calendarRoutes } from './routes/calendars.js';
import { commandRoutes } from './routes/commands.js';
import { healthRoute } from './routes/health.js';
import { meRoute } from './routes/me.js';
import { notificationRoutes } from './routes/notifications.js';
import type { Auth } from './auth/auth.js';
import type { RequestContext } from './auth/context.js';
import type { Database } from './db/client.js';

export interface AppEnv {
  Variables: {
    db: Database;
    /** Set by `requireContext`; absent on routes that do not require a session. */
    context: RequestContext;
    /**
     * The secret the assistant's stored API keys are encrypted under (§2.2).
     *
     * On the request rather than read from the environment where it is used,
     * for the same reason `db` and `clock` are: a module that reaches for
     * `process.env` is a module a test cannot put a different value into, and
     * the one thing worth testing about an encrypted column is what happens
     * when the key changes.
     */
    assistantSecret: string;
  };
}

/**
 * Where `now` comes from.
 *
 * The scheduler takes `now` as an explicit input (§6.3) and the read endpoints
 * have to get it from somewhere. Injecting it keeps that somewhere visible, and
 * keeps the alternative — a request header the server would have to trust —
 * from ever existing.
 */
export type Clock = () => Date;

export interface CreateAppOptions {
  db: Database;
  auth: Auth;
  corsOrigins?: string[];
  /** §12's retention window, surfaced by the audit view so a reader knows. */
  auditRetentionDays?: number;
  /** Off in tests so the suite output stays readable. */
  requestLogging?: boolean;
  clock?: Clock;
  /**
   * What the assistant's stored API keys are encrypted under (§2.2).
   *
   * `index.ts` passes `BETTER_AUTH_SECRET`. Left unset it becomes **fresh
   * random bytes**, not a constant: a published default is a published secret,
   * and the one that works in development is the one that reaches production.
   * Random means a deployment that forgets to pass it finds its stored keys
   * unreadable after the next restart — which is loud, recoverable in one
   * paste, and vastly better than ciphertext anyone with the source can open.
   */
  assistantSecret?: string;
}

/**
 * Builds the Hono app.
 *
 * Everything is mounted under `/api` so nginx has a single, unambiguous prefix
 * to reverse-proxy and the client can own every other path. The chained
 * `.route()` calls are load-bearing: `AppType` below is inferred from them and
 * is what gives the client an end-to-end typed contract (spec §3.1; the RPC
 * layer proper lands in M9).
 */
export function createApp({
  db,
  auth,
  corsOrigins = [],
  auditRetentionDays,
  requestLogging = true,
  clock = () => new Date(),
  assistantSecret = randomBytes(32).toString('hex'),
}: CreateAppOptions) {
  const app = new Hono<AppEnv>().basePath('/api');

  if (requestLogging) app.use('*', logger());

  /**
   * §14's rate limits, by route class.
   *
   * Applied before authentication on purpose: a limiter that only counted
   * *authenticated* requests would let an unauthenticated flood through to the
   * session lookup, which is the expensive part of rejecting one.
   *
   * **The paths are relative to the base path, and that is the whole of a bug
   * these three lines carried from M16c until it was measured.** `basePath`
   * prefixes `use()` exactly as it prefixes `get()`, so `'/api/auth/*'` on an
   * app already based at `/api` registers `/api/api/auth/*` — a path nothing
   * can ever request. All three limiters existed, typechecked, and matched
   * nothing; sign-in took thirty wrong passwords without complaint. Nothing
   * caught it because nothing tested that a limit was ever *reached*, which is
   * the one assertion a limiter needs. See `test/api/rate-limit.test.ts`.
   *
   * The catch-all counts auth and command requests too, since Hono runs every
   * middleware whose path matches rather than only the most specific. That is
   * left alone deliberately: it costs a command-heavy client 120 of its 600
   * reads, and the alternative is a second list of route classes to keep in
   * step with this one.
   */
  app.use('/auth/*', rateLimit(AUTH_LIMIT));
  app.use('/commands', rateLimit(COMMAND_LIMIT));
  // Tighter than everything else, because this is the one route where a loop
  // in a client spends the user's money rather than the server's CPU.
  app.use('/assistant/turn', rateLimit(ASSISTANT_LIMIT));
  app.use('/*', rateLimit(READ_LIMIT));

  if (corsOrigins.length > 0) {
    app.use('*', cors({ origin: corsOrigins, credentials: true }));
  }

  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('assistantSecret', assistantSecret);
    await next();
  });

  const routes = app
    .route('/', healthRoute)
    .route('/', authRoutes(auth))
    .route('/', meRoute(auth))
    .route('/', commandRoutes(auth, clock))
    .route('/', calendarRoutes(auth, clock, auditRetentionDays))
    .route('/', notificationRoutes(auth, clock))
    .route('/', assistantRoutes(auth));

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
