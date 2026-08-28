import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>['db'];

/**
 * The handle passed to a transaction callback. Derived rather than named
 * directly so it tracks the Drizzle instance's own schema typing.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

/**
 * Creates a connection pool and a Drizzle instance over it.
 *
 * Kept as a factory rather than a module-level singleton so tests can create an
 * isolated handle, and so the per-request RLS tenant context (spec §5.2, M1)
 * has an explicit seam to hook into later.
 */
export function createDatabase(
  databaseUrl: string,
  options?: postgres.Options<Record<string, postgres.PostgresType>>,
) {
  const sql = postgres(databaseUrl, {
    max: 10,
    onnotice: () => {},
    ...options,
  });

  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
