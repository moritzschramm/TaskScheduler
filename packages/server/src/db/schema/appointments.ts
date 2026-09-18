import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';
import { createdAtColumn, primaryKeyColumn, updatedAtColumn, versionColumn } from './columns.js';
import { appointmentStatus, participantStatus, visibilityScope } from './scheduling-enums.js';
import { calendars } from './calendars.js';
import { tenants } from './tenancy.js';
import { users } from './identity.js';

/**
 * Postgres `tstzrange`. Drizzle has no native range type, so it travels as its
 * text literal — `["2026-01-02 09:00+00","2026-01-02 10:00+00")`. Always
 * half-open, per spec §5.1.
 */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
});

/**
 * A block fixed in time, which tasks schedule around (spec §4.5). Appointments
 * are immovable as far as the solver is concerned (§6.2 rule 2).
 *
 * **Recurrence is datetime expansion here**, unlike a task's per-period demand
 * rule — two separate mechanisms sharing one UI concept (§8). A row is one of:
 *
 * - a plain appointment (no rule, no parent);
 * - a recurring *template* (`recurrenceRule` set), whose `during` is its first
 *   instance and whose later instances are expanded at read time in M14;
 * - a modified occurrence (`recurrenceParentId` + `recurrenceOriginalStart`
 *   set), overriding one instance of its template.
 *
 * `recurrenceTimezone` is mandatory alongside a rule: "every weekday 09:00" is
 * a wall-clock rule, and DST moves the underlying instant, so the zone has to
 * travel with the rule rather than be inferred from a stored offset (§5.1).
 */
export const appointments = pgTable(
  'appointments',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = inherit the calendar's scope. */
    visibilityScope: visibilityScope('visibility_scope'),

    title: text('title').notNull(),
    notes: text('notes'),

    /** Half-open `[start, end)`. Two blocks may share an hour (migration 0016). */
    during: tstzrange('during').notNull(),

    /**
     * True when every participant is an app user, which is what enables
     * cross-user change negotiation (§7.2). External appointments are the
     * user's own to renegotiate.
     */
    isInternal: boolean('is_internal').notNull().default(false),
    status: appointmentStatus('status').notNull().default('confirmed'),

    /**
     * A content-free hard block — "unavailable 14:00–16:00" (§7.4). Behaves
     * exactly like an appointment for scheduling, and is flagged so the UI can
     * render it without inventing a title.
     */
    isUnavailability: boolean('is_unavailability').notNull().default(false),

    /**
     * Non-compressible time reserved after the block (§6.2 rule 3).
     *
     * The same thing an activity type's default and a task's override express, for
     * the case they never covered: the twenty minutes it takes to get back from
     * a meeting across town. Part of the footprint the solver keeps clear, and
     * not part of the block — the block still ends when it ends, which is what
     * anyone reading the calendar is told.
     */
    cooldownMin: integer('cooldown_min').notNull().default(0),

    /** RFC 5545 RRULE (§8.1). */
    recurrenceRule: text('recurrence_rule'),
    /** IANA zone the rule's wall-clock times are expressed in. */
    recurrenceTimezone: text('recurrence_timezone'),
    /** Instances suppressed from the expansion (RFC 5545 EXDATE). */
    recurrenceExdates: timestamp('recurrence_exdates', {
      withTimezone: true,
      mode: 'string',
    }).array(),
    /** Set on a modified occurrence: the template it overrides. */
    recurrenceParentId: uuid('recurrence_parent_id'),
    /** Which instance of the template this row replaces. */
    recurrenceOriginalStart: timestamp('recurrence_original_start', {
      withTimezone: true,
      mode: 'string',
    }),

    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('appointments_id_tenant_key').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'appointments_calendar_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.recurrenceParentId, table.tenantId],
      foreignColumns: [table.id, table.tenantId],
      name: 'appointments_recurrence_parent_same_tenant_fk',
    }).onDelete('cascade'),

    index('appointments_calendar_idx').on(table.calendarId),
    index('appointments_recurrence_parent_idx').on(table.recurrenceParentId),

    check('appointments_cooldown_non_negative', sql`${table.cooldownMin} >= 0`),
    check(
      'appointments_recurrence_needs_timezone',
      sql`(${table.recurrenceRule} is null) = (${table.recurrenceTimezone} is null)`,
    ),
    // A modified occurrence names both its template and the instance it replaces.
    check(
      'appointments_exception_pair',
      sql`(${table.recurrenceParentId} is null) = (${table.recurrenceOriginalStart} is null)`,
    ),
    // A row is a template or an exception, never both.
    check(
      'appointments_template_or_exception',
      sql`${table.recurrenceRule} is null or ${table.recurrenceParentId} is null`,
    ),
  ],
);

/**
 * User ↔ Appointment with a status (spec §4.3). Modelled now, unused until the
 * deferred team features arrive — the seam the plan asks to keep intact.
 */
export const appointmentParticipants = pgTable(
  'appointment_participants',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: participantStatus('status').notNull().default('proposed'),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('appointment_participants_appointment_user_key').on(table.appointmentId, table.userId),
    foreignKey({
      columns: [table.appointmentId, table.tenantId],
      foreignColumns: [appointments.id, appointments.tenantId],
      name: 'appointment_participants_appointment_same_tenant_fk',
    }).onDelete('cascade'),
  ],
);

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type AppointmentParticipant = typeof appointmentParticipants.$inferSelect;
export type NewAppointmentParticipant = typeof appointmentParticipants.$inferInsert;
