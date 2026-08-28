import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthErrorSchema, healthResponseSchema } from '@ambitime/shared';
import { createApp } from '../src/app.js';
import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { setupTestDatabase } from './support/database.js';

describe('GET /api/health', () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await setupTestDatabase();
    app = createApp({ db: handle.db, requestLogging: false });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('reports ok and round-trips a real query to Postgres', async () => {
    const response = await app.request('/api/health');

    expect(response.status).toBe(200);

    // Parsed with the shared schema: the server's response and the client's
    // expectation are validated against one definition (spec §3.1).
    const body = healthResponseSchema.parse(await response.json());

    expect(body.status).toBe('ok');
    expect(body.database.reachable).toBe(true);
    // Bumped by each milestone's migration; asserting the exact value proves
    // migrations ran to completion, not just that the table exists.
    expect(body.database.schemaVersion).toBe('m1');
    expect(Number.isNaN(Date.parse(body.database.serverTime))).toBe(false);
    expect(body.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 with a diagnostic when the database is unreachable', async () => {
    const unreachable = createDatabase('postgres://nobody@127.0.0.1:1/nowhere', {
      max: 1,
      connect_timeout: 1,
    });
    const failingApp = createApp({ db: unreachable.db, requestLogging: false });

    const response = await failingApp.request('/api/health');

    expect(response.status).toBe(503);
    const body = healthErrorSchema.parse(await response.json());
    expect(body.status).toBe('error');
    expect(body.message.length).toBeGreaterThan(0);

    await unreachable.close();
  });

  it('404s an unknown route under the api prefix', async () => {
    const response = await app.request('/api/does-not-exist');
    expect(response.status).toBe(404);
  });
});
