import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, primaryKeyColumn, updatedAtColumn, versionColumn } from './columns.js';
import { notificationSeverity, notificationType } from './scheduling-enums.js';
import { tstzrange } from './appointments.js';
import { calendars } from './calendars.js';
import { taskOccurrences } from './tasks.js';
import { tenants } from './tenancy.js';
import { users } from './identity.js';

/**
 * The materialised schedule for the hard horizon — a **read cache**, not the
 * authoritative record (spec §3.4).
 *
 * Source of truth is the source entities plus the command log; this table is
 * recomputed whenever that changes, and kept as the baseline for change
 * detection ("what moved?"). Two consequences show up in the schema:
 *
 * - **No exclusion constraint.** Placements must not overlap (§6.2 rule 2), but
 *   that is the validator's job on a *proposed* schedule. A database constraint
 *   here would make a legal recompute fail midway purely on write ordering.
 * - **No `version`.** Optimistic locking guards user intent against concurrent
 *   edits; a derived cache is replaced wholesale, so there is nothing to lock.
 */
export const placements = pgTable(
  'placements',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    /** Placements are assigned to occurrences, never directly to tasks (§3.4). */
    occurrenceId: uuid('occurrence_id').notNull(),

    /** Half-open `[start, end)`, exclusive of the cooldown that follows it. */
    during: tstzrange('during').notNull(),
    /**
     * The cooldown reserved after `during`. Stored rather than re-derived so
     * the cache records the full footprint the solver reserved (§6.2 rule 3),
     * even if the category default changes afterwards.
     */
    cooldownMin: integer('cooldown_min').notNull().default(0),

    /** Which solve produced this row; the baseline for change detection. */
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    createdAt: createdAtColumn(),
  },
  (table) => [
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'placements_calendar_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.occurrenceId, table.tenantId],
      foreignColumns: [taskOccurrences.id, taskOccurrences.tenantId],
      name: 'placements_occurrence_same_tenant_fk',
    }).onDelete('cascade'),

    // One placement per occurrence within the horizon. Not an exclusion
    // constraint — see the class comment.
    unique('placements_occurrence_key').on(table.occurrenceId),
    index('placements_calendar_idx').on(table.calendarId),
    check('placements_cooldown_non_negative', sql`${table.cooldownMin} >= 0`),
  ],
);

/**
 * The append-only command log (spec §7.1, §12) — the single write path.
 *
 * One log serves undo/redo, history and audit. It is genuinely append-only:
 * UPDATE and DELETE privileges are revoked from the application role in the
 * migration, so "undone" is not a column that gets flipped. Undo is itself a
 * command naming its target (§7.5), which keeps the log an honest record of
 * what was intended, in order, including the intent to reverse.
 *
 * No `version`: nothing here is ever updated, so there is nothing to lock.
 */
export const commands = pgTable(
  'commands',
  {
    id: primaryKeyColumn(),
    /**
     * Strict total order for replay and undo. UUID v7 is time-ordered but can
     * tie; this cannot, and undo has to walk the log backwards unambiguously.
     */
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** e.g. `PostponeRestOfDay` (§7.2). */
    type: text('type').notNull(),
    params: jsonb('params').notNull(),

    /**
     * Groups the commands of one bulk action so undo reverses them atomically
     * (§7.5). NULL for a standalone command.
     */
    groupId: uuid('group_id'),

    /** Enough state to reverse this command (§12). Written at insert time. */
    inverse: jsonb('inverse'),

    /** Optimistic lock the command was issued against (§5.4, §7.1). */
    expectedVersion: integer('expected_version'),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    unique('commands_seq_key').on(table.seq),
    index('commands_tenant_seq_idx').on(table.tenantId, table.seq),
    index('commands_group_idx').on(table.groupId),
  ],
);

/**
 * A user-facing message (spec §11). Delivery — in-app when online, email when
 * offline, driven by pg-boss — is M15; this table is only the record.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    type: notificationType('type').notNull(),
    /** Warning versus alert is the §6.5 soft/hard due-date distinction. */
    severity: notificationSeverity('severity').notNull(),
    /** Which entity this is about, and any diagnostic detail (§6.7). */
    payload: jsonb('payload').notNull(),

    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),

    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index('notifications_user_unread_idx').on(table.userId, table.readAt)],
);

export type Placement = typeof placements.$inferSelect;
export type NewPlacement = typeof placements.$inferInsert;
export type Command = typeof commands.$inferSelect;
export type NewCommand = typeof commands.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
