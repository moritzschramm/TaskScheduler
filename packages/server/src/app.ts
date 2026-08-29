import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authRoutes } from './auth/middleware.js';
import { healthRoute } from './routes/health.js';
import { meRoute } from './routes/me.js';
import type { Auth } from './auth/auth.js';
import type { RequestContext } from './auth/context.js';
import type { Database } from './db/client.js';

export interface AppEnv {
  Variables: {
    db: Database;
    /** Set by `requireContext`; absent on routes that do not require a session. */
    context: RequestContext;
  };
}

export interface CreateAppOptions {
  db: Database;
  auth: Auth;
  corsOrigins?: string[];
  /** Off in tests so the suite output stays readable. */
  requestLogging?: boolean;
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
export function createApp({ db, auth, corsOrigins = [], requestLogging = true }: CreateAppOptions) {
  const app = new Hono<AppEnv>().basePath('/api');

  if (requestLogging) app.use('*', logger());

  if (corsOrigins.length > 0) {
    app.use('*', cors({ origin: corsOrigins, credentials: true }));
  }

  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  const routes = app.route('/', healthRoute).route('/', authRoutes(auth)).route('/', meRoute(auth));

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
