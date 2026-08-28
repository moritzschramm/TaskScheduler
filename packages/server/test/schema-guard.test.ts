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
 * Tables the application role may read but never write. `ALTER DEFAULT
 * PRIVILEGES` grants DML on everything by default, so each entry here is a
 * deliberate revoke in migration 0002 — not an oversight.
 */
const READ_ONLY_TABLES = ['app_meta'];

/** Postgres array literal, built in SQL so the list stays a bound parameter. */
const readOnlyTableList = READ_ONLY_TABLES.join(',');

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
           and not has_table_privilege(${APP_ROLE}, c.oid, 'SELECT')
         order by 1
      `,
    );

    expect(missing).toEqual([]);
  });

  it('gives the application role write privileges on every table but the read-only ones', async () => {
    const missing = await handle.db.execute<{ table_name: string; privilege: string }>(
      sql`
        select c.relname as table_name, needed.privilege
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as needed(privilege)
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname <> all(string_to_array(${readOnlyTableList}, ','))
           and not has_table_privilege(${APP_ROLE}, c.oid, needed.privilege)
         order by 1, 2
      `,
    );

    expect(missing).toEqual([]);
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
           and c.relname = any(string_to_array(${readOnlyTableList}, ','))
           and has_table_privilege(${APP_ROLE}, c.oid, granted.privilege)
         order by 1, 2
      `,
    );

    expect(writable).toEqual([]);
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
