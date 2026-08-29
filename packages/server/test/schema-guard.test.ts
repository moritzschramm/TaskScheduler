import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE } from '../src/db/context.js';
import { runMigrations } from '../src/db/migrate.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { setupTestDatabase, TEST_DATABASE_URL } from './support/database.js';

/**
 * Standing guards over the whole schema rather than any one table.
 *
 * `drizzle-kit generate` produces DDL from the Drizzle schema and knows nothing
 * about the policies in the hand-written migration, so a table added in a later
 * milestone would arrive unprotected and nothing else would notice. These tests
 * are what notices — they should fail loudly the first time M2 adds a
 * scheduling table without RLS.
 */
/**
 * Write access is granted by `ALTER DEFAULT PRIVILEGES`, so every table is
 * fully writable unless a migration deliberately revokes something. These two
 * lists are that deliberation, written down — each entry is a revoke in a
 * migration, not an oversight, and the tests below hold them to it in both
 * directions.
 */

/** No INSERT, UPDATE or DELETE. Migration-owned configuration. */
const READ_ONLY_TABLES = ['app_meta'];

/** INSERT only — the command log is append-only (spec §12). */
const APPEND_ONLY_TABLES = ['commands'];

/**
 * Not reachable from a tenant-scoped request **at all** (migration 0005).
 *
 * Password hashes and live session tokens. Every other table is protected by
 * being filtered; these are protected by not being granted, and then by having
 * RLS enabled behind that with no policy — so two independent things would have
 * to be wrong before one leaked. Better Auth reaches them on the system path.
 */
const UNREACHABLE_TABLES = [
  'accounts',
  'invitations',
  'sessions',
  'sso_providers',
  'verifications',
];

/** Joined in JS and split in SQL, so the lists stay bound parameters. */
const readOnlyList = READ_ONLY_TABLES.join(',');
const appendOnlyList = APPEND_ONLY_TABLES.join(',');
const unreachableList = UNREACHABLE_TABLES.join(',');
const restrictedList = [...READ_ONLY_TABLES, ...APPEND_ONLY_TABLES, ...UNREACHABLE_TABLES].join(
  ',',
);

describe('schema-wide guards', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('protects every table with RLS and at least one policy', async () => {
    const rows = await handle.db.execute<{
      table_name: string;
      enabled: boolean;
      policies: number;
    }>(
      sql`
        select c.relname as table_name,
               c.relrowsecurity as enabled,
               count(p.polname)::int as policies
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_policy p on p.polrelid = c.oid
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname <> all(string_to_array(${unreachableList}, ','))
         group by c.relname, c.relrowsecurity
         order by c.relname
      `,
    );

    expect(rows.length).toBeGreaterThan(0);

    const unprotected = rows.filter((r) => !r.enabled || r.policies === 0);
    expect(unprotected).toEqual([]);
  });

  it('gives the application role neither superuser nor BYPASSRLS', async () => {
    // The single assumption the whole isolation model rests on. If this role
    // ever gained either attribute, every policy above would quietly stop
    // filtering and every other test here would still pass.
    const [role] = await handle.db.execute<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      sql`select rolsuper, rolbypassrls, rolcanlogin
            from pg_roles where rolname = ${APP_ROLE}`,
    );

    expect(role).toBeDefined();
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
    // NOLOGIN: reachable only by SET ROLE from an authenticated connection.
    expect(role?.rolcanlogin).toBe(false);
  });

  it('lets the application role read every table', async () => {
    const missing = await handle.db.execute<{ table_name: string }>(
      sql`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname <> all(string_to_array(${unreachableList}, ','))
           and not has_table_privilege(${APP_ROLE}, c.oid, 'SELECT')
         order by 1
      `,
    );

    expect(missing).toEqual([]);
  });

  it('gives the application role full write access to every unrestricted table', async () => {
    const missing = await handle.db.execute<{ table_name: string; privilege: string }>(
      sql`
        select c.relname as table_name, needed.privilege
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as needed(privilege)
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname <> all(string_to_array(${restrictedList}, ','))
           and not has_table_privilege(${APP_ROLE}, c.oid, needed.privilege)
         order by 1, 2
      `,
    );

    expect(missing).toEqual([]);
  });

  it('keeps the auth tables out of the application role reach entirely', async () => {
    // Not "filtered to the right rows" — *no* rows, by two mechanisms. A
    // session token read through a tenant-scoped request would be a total
    // compromise of the isolation model, so it gets belt and braces.
    const reachable = await handle.db.execute<{ table_name: string; privilege: string }>(
      sql`
        select c.relname as table_name, granted.privilege
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as granted(privilege)
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname = any(string_to_array(${unreachableList}, ','))
           and has_table_privilege(${APP_ROLE}, c.oid, granted.privilege)
         order by 1, 2
      `,
    );

    expect(reachable).toEqual([]);

    const unguarded = await handle.db.execute<{ table_name: string }>(
      sql`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_policy p on p.polrelid = c.oid
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname = any(string_to_array(${unreachableList}, ','))
         group by c.relname, c.relrowsecurity
        having not c.relrowsecurity or count(p.polname) > 0
         order by 1
      `,
    );

    expect(unguarded).toEqual([]);
  });

  it('keeps the read-only tables genuinely read-only', async () => {
    const writable = await handle.db.execute<{ table_name: string; privilege: string }>(
      sql`
        select c.relname as table_name, granted.privilege
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as granted(privilege)
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname = any(string_to_array(${readOnlyList}, ','))
           and has_table_privilege(${APP_ROLE}, c.oid, granted.privilege)
         order by 1, 2
      `,
    );

    expect(writable).toEqual([]);
  });

  it('lets the append-only tables be inserted into but never rewritten', async () => {
    const wrong = await handle.db.execute<{ table_name: string; privilege: string }>(
      sql`
        with target as (
          select c.oid, c.relname
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relkind = 'r'
             and c.relname = any(string_to_array(${appendOnlyList}, ','))
        )
        select relname as table_name, 'INSERT' as privilege
          from target where not has_table_privilege(${APP_ROLE}, oid, 'INSERT')
        union all
        select relname, granted.privilege
          from target
         cross join (values ('UPDATE'), ('DELETE')) as granted(privilege)
         where has_table_privilege(${APP_ROLE}, oid, granted.privilege)
         order by 1, 2
      `,
    );

    expect(wrong).toEqual([]);
  });

  it('keeps a touch_row trigger on every versioned table', async () => {
    // Without it, `version` never advances and optimistic locking (spec §5.4)
    // silently accepts every concurrent write.
    const missing = await handle.db.execute<{ table_name: string }>(
      sql`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'version' and a.attnum > 0
         where n.nspname = 'public'
           and c.relkind = 'r'
           and not exists (
             select 1 from pg_trigger t
              where t.tgrelid = c.oid
                and not t.tgisinternal
                and t.tgname = c.relname || '_touch_row'
           )
         order by 1
      `,
    );

    expect(missing).toEqual([]);
  });

  it('uses uuidv7 for every primary key default', async () => {
    // Time-ordered ids are what give the scheduler deterministic tie-breaks
    // (spec §5.1, §6.3); a stray uuid_generate_v4 would break that quietly.
    const wrong = await handle.db.execute<{ table_name: string; column_name: string }>(
      sql`
        select c.relname as table_name, a.attname as column_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
         where n.nspname = 'public'
           and c.relkind = 'r'
           and a.attname = 'id'
           and format_type(a.atttypid, null) = 'uuid'
           and pg_get_expr(d.adbin, d.adrelid) <> 'uuidv7()'
         order by 1
      `,
    );

    expect(wrong).toEqual([]);
  });

  it('applies migrations idempotently', async () => {
    // The server container's entrypoint runs migrations on every start, so a
    // second pass over an already-migrated database has to be a no-op rather
    // than an error.
    const before = await handle.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );

    await expect(runMigrations(TEST_DATABASE_URL)).resolves.toBeUndefined();

    const after = await handle.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });
});
