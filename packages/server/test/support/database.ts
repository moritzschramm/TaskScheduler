import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Integration tests run against a real Postgres — `/health` proves the query
 * path, so faking the database would test nothing. CI provides one as a service
 * container; locally, `docker compose up postgres` is enough.
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://ambitime:ambitime@localhost:5432/ambitime';

export async function setupTestDatabase(): Promise<DatabaseHandle> {
  await runMigrations(TEST_DATABASE_URL);
  return createDatabase(TEST_DATABASE_URL, { max: 2 });
}
