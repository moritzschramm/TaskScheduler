import { sql } from 'drizzle-orm';
import type { CategoryColor } from '@ambitime/shared';
import {
  check,
  date,
  foreignKey,
  integer,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, primaryKeyColumn, updatedAtColumn, versionColumn } from './columns.js';
import { calendarWindowKind, visibilityScope } from './scheduling-enums.js';
import { memberships, tenants } from './tenancy.js';
import { users } from './identity.js';

/**
 * A scheduling *context* owned by a user within a tenant (spec §4.3). A user
 * may own several; the engine operates over the union of the calendars a user
 * can access (§9.3).
 *
 * `timezone` is not named in the spec, but availability windows are wall-clock
 * rules ("Tuesdays 09:00") and something has to resolve them to instants. Spec
 * §5.1 already requires recurrence rules to carry an explicit timezone for the
 * same reason — DST shifts the instant while the wall-clock rule stays put — so
 * the calendar, being the scheduling context, is where it belongs.
 */
export const calendars = pgTable(
  'calendars',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Spec §10.2: resources carry owner + scope so a ReBAC migration is additive. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    visibilityScope: visibilityScope('visibility_scope').notNull().default('private'),
    /** IANA zone name, e.g. `Europe/Berlin`. */
    timezone: text('timezone').notNull().default('UTC'),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('calendars_id_tenant_key').on(table.id, table.tenantId),
    unique('calendars_tenant_owner_name_key').on(table.tenantId, table.ownerId, table.name),
    // The owner must hold a membership in the calendar's tenant — the same
    // structural guard M1 uses for team membership. Note the consequence:
    // revoking someone's membership cascades away the calendars they own in
    // that tenant, and everything scoped to them.
    foreignKey({
      columns: [table.tenantId, table.ownerId],
      foreignColumns: [memberships.tenantId, memberships.userId],
      name: 'calendars_owner_requires_membership_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * The two windows of spec §9.1, sharing one shape:
 *
 * - `working`   — when the scheduler may place tasks for this calendar.
 * - `shareable` — what busy time is exposed to *other users* (§9.2), which is
 *   what a private block outside this window is clipped against.
 *
 * Per-weekday rather than a single daily range, so "Mon–Thu 08:00–18:00, Fri
 * 08:00–13:00" is expressible, and so the §9.4 divergence comparison against a
 * team's window stays a plain query.
 */
export const calendarWindows = pgTable(
  'calendar_windows',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    kind: calendarWindowKind('kind').notNull(),
    /** ISO-8601 weekday: 1 = Monday … 7 = Sunday, matching `extract(isodow)`. */
    weekday: smallint('weekday').notNull(),
    /** Minutes since local midnight; half-open `[start, end)` per spec §5.1. */
    startMin: integer('start_min').notNull(),
    endMin: integer('end_min').notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'calendar_windows_calendar_same_tenant_fk',
    }).onDelete('cascade'),
    check('calendar_windows_weekday_range', sql`${table.weekday} between 1 and 7`),
    // A window crossing midnight is modelled as two rows; keeping start < end
    // means every comparison in the engine is a plain integer comparison.
    check(
      'calendar_windows_minute_range',
      sql`${table.startMin} >= 0 and ${table.endMin} <= 1440 and ${table.startMin} < ${table.endMin}`,
    ),
  ],
);

/**
 * A kind of activity — work, exercise, wellness, household (spec §4.3).
 * Tenant-scoped, and owns the default cooldown for its tasks.
 */
export const categories = pgTable(
  'categories',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Non-compressible gap reserved after each task of this category (§6.2). */
    defaultCooldownMin: integer('default_cooldown_min').notNull().default(0),
    /**
     * Which palette slot the grid draws this type's hours in (§4.3).
     *
     * A slot name rather than a hex value — one hex cannot be right on both a
     * light and a dark surface. Null is a real state: the slots do not cycle,
     * so a ninth activity type has none. See `@ambitime/shared`'s palette.
     */
    color: text('color').$type<CategoryColor>(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('categories_id_tenant_key').on(table.id, table.tenantId),
    unique('categories_tenant_name_key').on(table.tenantId, table.name),
    check('categories_cooldown_non_negative', sql`${table.defaultCooldownMin} >= 0`),
    check(
      'categories_color_is_a_palette_slot',
      sql`${table.color} is null or ${table.color} in ('blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red')`,
    ),
  ],
);

/**
 * Replaces the default window set for a date range — holidays, a conference
 * week, parental leave (spec §4.3).
 *
 * Availability windows point *at* an override rather than the other way round:
 * a window with `week_type_override_id IS NULL` belongs to the default set, and
 * one with it set belongs to that override's replacement set.
 *
 * Deliberately **no** exclusion constraint on overlapping ranges — the plan
 * scopes exclusion constraints to appointments only. Overlap resolution is the
 * engine's business.
 */
export const weekTypeOverrides = pgTable(
  'week_type_overrides',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    name: text('name').notNull(),
    /** Half-open `[start, end)`, consistent with every other interval (§5.1). */
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('week_type_overrides_id_tenant_key').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'week_type_overrides_calendar_same_tenant_fk',
    }).onDelete('cascade'),
    check('week_type_overrides_date_range', sql`${table.startDate} < ${table.endDate}`),
  ],
);

/**
 * A per-weekday time range during which a category's tasks may be placed within
 * a calendar (spec §4.3).
 *
 * `focusLevel` is the "window focus profile" the task's own `focus_level` is
 * matched against by the `Pr` scoring term (§6.5).
 */
export const availabilityWindows = pgTable(
  'availability_windows',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    /** NULL = part of the default set; set = part of that override's set. */
    weekTypeOverrideId: uuid('week_type_override_id'),
    /** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
    weekday: smallint('weekday').notNull(),
    startMin: integer('start_min').notNull(),
    endMin: integer('end_min').notNull(),
    /** 1 (shallow) … 5 (deep); level count is a tuning value per spec §15. */
    focusLevel: smallint('focus_level'),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'availability_windows_calendar_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.categoryId, table.tenantId],
      foreignColumns: [categories.id, categories.tenantId],
      name: 'availability_windows_category_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.weekTypeOverrideId, table.tenantId],
      foreignColumns: [weekTypeOverrides.id, weekTypeOverrides.tenantId],
      name: 'availability_windows_override_same_tenant_fk',
    }).onDelete('cascade'),
    check('availability_windows_weekday_range', sql`${table.weekday} between 1 and 7`),
    check(
      'availability_windows_minute_range',
      sql`${table.startMin} >= 0 and ${table.endMin} <= 1440 and ${table.startMin} < ${table.endMin}`,
    ),
    check(
      'availability_windows_focus_level_range',
      sql`${table.focusLevel} is null or ${table.focusLevel} between 1 and 5`,
    ),
  ],
);

export type Calendar = typeof calendars.$inferSelect;
export type NewCalendar = typeof calendars.$inferInsert;
export type CalendarWindow = typeof calendarWindows.$inferSelect;
export type NewCalendarWindow = typeof calendarWindows.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type WeekTypeOverride = typeof weekTypeOverrides.$inferSelect;
export type NewWeekTypeOverride = typeof weekTypeOverrides.$inferInsert;
export type AvailabilityWindow = typeof availabilityWindows.$inferSelect;
export type NewAvailabilityWindow = typeof availabilityWindows.$inferInsert;
