import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDatabase } from './db/client.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const { db, close } = createDatabase(env.DATABASE_URL);

const app = createApp({
  db,
  corsOrigins: env.corsOrigins,
  requestLogging: env.NODE_ENV !== 'test',
});

const server = serve({ fetch: app.fetch, port: env.SERVER_PORT }, (info) => {
  console.warn(`ambitime server listening on :${info.port} (${env.NODE_ENV})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void close().then(() => process.exit(0));
    });
  });
}
