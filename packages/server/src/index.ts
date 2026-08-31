import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createAuth } from './auth/auth.js';
import { createDatabase } from './db/client.js';
import { loadEnv } from './env.js';
import { startWorker } from './jobs/queue.js';

const env = loadEnv();
const { db, close } = createDatabase(env.DATABASE_URL);

const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: env.corsOrigins,
});

const app = createApp({
  db,
  auth,
  corsOrigins: env.corsOrigins,
  requestLogging: env.NODE_ENV !== 'test',
  ...(env.AUDIT_RETENTION_DAYS === undefined
    ? {}
    : { auditRetentionDays: env.AUDIT_RETENTION_DAYS }),
});

const server = serve({ fetch: app.fetch, port: env.SERVER_PORT }, (info) => {
  console.warn(`ambitime server listening on :${info.port} (${env.NODE_ENV})`);
});

/**
 * The background worker runs in the same process as the API (spec §11).
 *
 * One process is the right shape at this size: the queue is in the same
 * Postgres as the data, so there is nothing to coordinate, and pg-boss's own
 * locking means running several copies is a scaling decision rather than a
 * design change. Splitting it out is a deployment change later, not a rewrite.
 */
const worker = await startWorker({ db, databaseUrl: env.DATABASE_URL });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      // The worker stops gracefully first: a refresh cut off mid-transaction
      // rolls back and is redelivered, which is safe but means a deploy costs
      // a re-solve of every calendar it interrupted.
      void worker
        .stop()
        .then(() => close())
        .then(() => process.exit(0));
    });
  });
}
