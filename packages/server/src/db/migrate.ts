import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './client.js';
import { loadEnv } from '../env.js';

/**
 * The migrations folder sits at a different depth in dev (`src/db/`) than in the
 * production bundle (`dist/`), so we walk up looking for it rather than hard-coding
 * a relative path that silently breaks in one of the two layouts.
 * `MIGRATIONS_DIR` overrides for anything unusual.
 */
export function resolveMigrationsFolder(from = dirname(fileURLToPath(import.meta.url))): string {
  const override = process.env['MIGRATIONS_DIR'];
  if (override) return resolve(override);

  let current = from;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Could not locate a drizzle migrations folder starting from ${from}`);
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  // A dedicated single connection: the migrator takes locks and should not
  // compete with the application pool.
  const handle = createDatabase(databaseUrl, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: resolveMigrationsFolder() });
  } finally {
    await handle.close();
  }
}

// Executed directly by `pnpm db:migrate` and by the container entrypoint.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL);
  console.warn('migrations applied');
}
