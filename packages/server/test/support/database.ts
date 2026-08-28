import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Integration tests run against a real Postgres. Row-level security, deferred
 * constraint triggers and `SET LOCAL ROLE` have no meaningful fake — a mocked
 * database would assert nothing about the thing under test.
 *
 * CI provides one as a service container; locally, `docker compose up -d
 * postgres` is enough.
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://ambitime:ambitime@localhost:5432/ambitime';

export async function setupTestDatabase(): Promise<DatabaseHandle> {
  await runMigrations(TEST_DATABASE_URL);
  return createDatabase(TEST_DATABASE_URL, { max: 4 });
}

/**
 * Clears every domain table between tests. `users` cascades to tenants,
 * memberships and everything below, so truncating it is enough — but the others
 * are named anyway so the intent survives a future schema change.
 *
 * `app_meta` is deliberately excluded: it is migration-owned configuration, not
 * test data.
 */
export async function resetDomainTables(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(sql`
    truncate table
      team_memberships, team_groups, teams, groups, memberships, tenants,
      email_identities, users
    restart identity cascade
  `);
}
