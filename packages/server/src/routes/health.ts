import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { healthResponseSchema, type HealthError, type HealthResponse } from '@ambitime/shared';
import { appMeta } from '../db/schema/index.js';
import type { Database } from '../db/client.js';

export interface HealthEnv {
  Variables: { db: Database };
}

const SCHEMA_VERSION_KEY = 'schema_version';

/**
 * Liveness *and* readiness in one: it is only `ok` if a real query round-trips
 * to Postgres. Booting without a database is not healthy for this app.
 */
export const healthRoute = new Hono<HealthEnv>().get('/health', async (c) => {
  const db = c.get('db');
  const startedAt = performance.now();

  try {
    // Formatted in SQL rather than parsed from the driver's own timestamptz
    // representation: one unambiguous ISO-8601 UTC string, no JS Date round-trip.
    const [meta] = await db
      .select({
        value: appMeta.value,
        serverTime: sql<string>`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .from(appMeta)
      .where(eq(appMeta.key, SCHEMA_VERSION_KEY))
      .limit(1);

    if (!meta) {
      const body: HealthError = {
        status: 'error',
        message: `Database reachable but '${SCHEMA_VERSION_KEY}' is missing from app_meta — migrations may not have run.`,
      };
      return c.json(body, 503);
    }

    const body: HealthResponse = healthResponseSchema.parse({
      status: 'ok',
      database: {
        reachable: true,
        schemaVersion: meta.value,
        serverTime: meta.serverTime,
        latencyMs: Math.round(performance.now() - startedAt),
      },
    });

    return c.json(body, 200);
  } catch (cause) {
    const body: HealthError = {
      status: 'error',
      message: cause instanceof Error ? cause.message : 'Database query failed',
    };
    return c.json(body, 503);
  }
});
