import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Application-level key/value metadata.
 *
 * At M0 this exists to give the walking skeleton something real to read: the
 * first migration creates and seeds it, and `/health` selects from it, which
 * proves migrations ran and the query path works end to end. The real domain
 * schema arrives in M1 (identity/tenancy) and M2 (scheduling).
 *
 * Not tenant-scoped: this is app-global, not user data.
 */
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type AppMetaRow = typeof appMeta.$inferSelect;
