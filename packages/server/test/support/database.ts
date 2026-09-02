import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Integration tests run against a real Postgres. Row-level security, deferred
 * constraint triggers and `SET LOCAL ROLE` have no meaningful fake — a mocked
 * database would assert nothing about the thing under test.
 *
 * CI provides one as a service container; locally, `docker compose up -d
 * postgres` is enough.
 *
 * **They run against their own database, and never against `DATABASE_URL`.**
 * That variable names the database the application is *running* on, and these
 * tests truncate `users` between cases — so falling back to it meant
 * `pnpm test` silently deleting the account you had just been using, along
 * with the planner, categories and hours behind it. The fallback was there to
 * save a line of configuration and it cost real data twice.
 *
 * `TEST_DATABASE_URL` is still honoured, because a caller who names a database
 * explicitly has said what they mean. Everything else lands in a database whose
 * name says what it is for.
 */
const DEFAULT_TEST_DATABASE_URL = 'postgres://ambitime:ambitime@localhost:5432/ambitime_test';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;

/**
 * Guards against the one mistake this module exists to prevent.
 *
 * An explicit `TEST_DATABASE_URL` is a decision and is left alone — except when
 * it is character-for-character the application's own, which is not a decision
 * but the same accident wearing a different variable.
 */
function assertNotTheRunningApplication(): void {
  const live = process.env['DATABASE_URL'];
  if (live !== undefined && live === TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is the same as DATABASE_URL. These tests truncate every ' +
        'domain table between cases; point them at a database of their own.',
    );
  }
}

/**
 * Creates the test database if it is not there yet.
 *
 * Connects to `postgres`, the maintenance database every server has, because
 * `CREATE DATABASE` cannot run from inside the database being created. Doing it
 * here rather than in a setup script keeps `pnpm test` a single command on a
 * machine that has only ever run `docker compose up -d postgres`.
 */
async function ensureDatabaseExists(): Promise<void> {
  const target = new URL(TEST_DATABASE_URL);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (name === '') throw new Error(`No database name in TEST_DATABASE_URL: ${TEST_DATABASE_URL}`);

  const maintenance = new URL(TEST_DATABASE_URL);
  maintenance.pathname = '/postgres';

  const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  try {
    const [existing] = await admin`select 1 from pg_database where datname = ${name}`;
    // Not `create database if not exists` — Postgres has no such form — and not
    // wrapped in a transaction, which `CREATE DATABASE` forbids.
    if (existing === undefined) await admin.unsafe(`create database "${name}"`);
  } catch (cause) {
    // A concurrent worker may have won the race between the check and the
    // create; that is success, not failure.
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.includes('already exists')) throw cause;
  } finally {
    await admin.end();
  }
}

export async function setupTestDatabase(): Promise<DatabaseHandle> {
  assertNotTheRunningApplication();
  await ensureDatabaseExists();
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
