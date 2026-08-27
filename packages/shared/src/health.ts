import { z } from 'zod';

/**
 * The walking-skeleton contract (plan M0). Defined once here and imported by
 * both server and client, per the global convention that types and validation
 * derive from a single source (spec §3.1).
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  /** Round-trip proof that the server reached Postgres, not just that it booted. */
  database: z.object({
    reachable: z.literal(true),
    /** Value read back from the `app_meta` table created by the first migration. */
    schemaVersion: z.string(),
    /** `now()` as reported by Postgres, ISO-8601 UTC. */
    serverTime: z.iso.datetime({ offset: true }),
    latencyMs: z.number().int().nonnegative(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const healthErrorSchema = z.object({
  status: z.literal('error'),
  message: z.string(),
});

export type HealthError = z.infer<typeof healthErrorSchema>;
