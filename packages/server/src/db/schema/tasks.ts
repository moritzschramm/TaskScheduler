import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, primaryKeyColumn, updatedAtColumn, versionColumn } from './columns.js';
import {
  dueKind,
  missedOccurrencePolicy,
  occurrenceStatus,
  recurrencePeriod,
  taskStatus,
  visibilityScope,
} from './scheduling-enums.js';
import { calendars, categories } from './calendars.js';
import { tenants } from './tenancy.js';
import { users } from './identity.js';

/**
 * An uninterruptible block grouping member tasks (spec §4.3, §6.4). The engine
 * collapses it to a composite of summed durations plus internal cooldowns,
 * places it contiguously inside one window, then expands it again (M5).
 */
export const sequences = pgTable(
  'sequences',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    name: text('name').notNull(),
    /** When true, members are placed in `sequencePosition` order (§6.2 rule 5). */
    isOrdered: boolean('is_ordered').notNull().default(false),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('sequences_id_tenant_key').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'sequences_calendar_same_tenant_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * The schedulable unit (spec §4.4).
 *
 * **Inheritance.** Category, priority, due date, preferred range/focus and
 * cooldown are all nullable here on purpose: a NULL means "inherit from the
 * nearest ancestor that sets it", and setting a value locally creates an
 * override. Only leaf tasks are placed; a parent's duration and completion roll
 * up from its leaves.
 *
 * **Hierarchy.** An adjacency list with a maintained `depth`, capped at 5. The
 * `depth` column, the cycle check and the cap are all enforced by the
 * `tasks_enforce_hierarchy` trigger — depth ≤ 5 keeps a recursive CTE cheap and
 * makes `ltree` or a closure table unnecessary (§5.3).
 *
 * `due_date` is a `timestamptz`, despite the name the spec gives it: §6.2 rule
 * 4 compares a *placement end* against it, which is an instant comparison. The
 * spec's column name is kept so this table reads against §4.4 directly.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id').notNull(),
    /** Spec §10.2: owner + scope now, so a ReBAC migration stays additive. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = inherit the calendar's scope. */
    visibilityScope: visibilityScope('visibility_scope'),

    title: text('title').notNull(),
    notes: text('notes'),

    /** Adjacency list; NULL for a root task. */
    parentId: uuid('parent_id'),
    /** Maintained by trigger. 1 for a root, capped at 5 (§4.4). */
    depth: smallint('depth').notNull().default(1),

    /** Inheritable. Determines which availability windows are eligible. */
    categoryId: uuid('category_id'),

    /** Required for leaves; a parent's duration rolls up from its leaves. */
    estimatedDurationMin: integer('estimated_duration_min'),

    /** Inheritable, optional, soft. Level count is a tuning value (§15). */
    priority: smallint('priority'),

    /** Inheritable. See the class comment on the timestamptz choice. */
    dueDate: timestamp('due_date', { withTimezone: true, mode: 'string' }),
    dueKind: dueKind('due_kind'),

    /** Inheritable soft preference: minutes since local midnight, half-open. */
    preferredStartMin: integer('preferred_start_min'),
    preferredEndMin: integer('preferred_end_min'),
    /** 1 (shallow) … 5 (deep), matched against a window's focus profile (§6.5). */
    focusLevel: smallint('focus_level'),

    /** Inheritable; overrides the category default. Non-compressible (§6.2). */
    cooldownOverrideMin: integer('cooldown_override_min'),

    sequenceId: uuid('sequence_id'),
    /** Position within an ordered sequence; NULL when the sequence is unordered. */
    sequencePosition: smallint('sequence_position'),

    /** Per-period demand rule (§8.2), not a datetime rule. */
    recurrencePeriod: recurrencePeriod('recurrence_period'),
    /** e.g. 3 with period `week` = "exercise 3× per week". */
    recurrenceCount: smallint('recurrence_count'),
    missedOccurrencePolicy: missedOccurrencePolicy('missed_occurrence_policy')
      .notNull()
      .default('rollover'),

    /** Soft not-before, set by a manual reposition (§7.3). Cleared on complete. */
    manualFloor: timestamp('manual_floor', { withTimezone: true, mode: 'string' }),
    /** Preferred datetime from that same reposition; a bias, not a pin. */
    manualBias: timestamp('manual_bias', { withTimezone: true, mode: 'string' }),

    /** Backlog placement beyond the hard horizon (§6.1): the week's start date. */
    estimatedWeek: date('estimated_week'),

    /** Deferral tracking, distinct from involuntary reflow (§6.6). */
    deferCount: integer('defer_count').notNull().default(0),
    lastDeferReason: text('last_defer_reason'),
    lastDeferAt: timestamp('last_defer_at', { withTimezone: true, mode: 'string' }),

    status: taskStatus('status').notNull().default('active'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),

    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('tasks_id_tenant_key').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'tasks_calendar_same_tenant_fk',
    }).onDelete('cascade'),
    // Self-reference within one tenant. Deleting a parent deletes its subtree.
    foreignKey({
      columns: [table.parentId, table.tenantId],
      foreignColumns: [table.id, table.tenantId],
      name: 'tasks_parent_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.categoryId, table.tenantId],
      foreignColumns: [categories.id, categories.tenantId],
      name: 'tasks_category_same_tenant_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.sequenceId, table.tenantId],
      foreignColumns: [sequences.id, sequences.tenantId],
      name: 'tasks_sequence_same_tenant_fk',
    }).onDelete('set null'),

    index('tasks_parent_idx').on(table.parentId),
    index('tasks_calendar_status_idx').on(table.calendarId, table.status),
    index('tasks_sequence_idx').on(table.sequenceId),

    check('tasks_depth_range', sql`${table.depth} between 1 and 5`),
    check(
      'tasks_duration_positive',
      sql`${table.estimatedDurationMin} is null or ${table.estimatedDurationMin} > 0`,
    ),
    check(
      'tasks_cooldown_non_negative',
      sql`${table.cooldownOverrideMin} is null or ${table.cooldownOverrideMin} >= 0`,
    ),
    check(
      'tasks_focus_level_range',
      sql`${table.focusLevel} is null or ${table.focusLevel} between 1 and 5`,
    ),
    // Either both ends of the preferred range or neither, and half-open.
    check(
      'tasks_preferred_range_valid',
      sql`(${table.preferredStartMin} is null) = (${table.preferredEndMin} is null)
          and (${table.preferredStartMin} is null
               or (${table.preferredStartMin} >= 0
                   and ${table.preferredEndMin} <= 1440
                   and ${table.preferredStartMin} < ${table.preferredEndMin}))`,
    ),
    // A due kind without a due date says nothing; a due date without a kind is
    // ambiguous between warn and enforce.
    check('tasks_due_pair', sql`(${table.dueDate} is null) = (${table.dueKind} is null)`),
    // Recurrence is all-or-nothing: a period needs a count and vice versa.
    check(
      'tasks_recurrence_pair',
      sql`(${table.recurrencePeriod} is null) = (${table.recurrenceCount} is null)
          and (${table.recurrenceCount} is null or ${table.recurrenceCount} > 0)`,
    ),
    check('tasks_defer_count_non_negative', sql`${table.deferCount} >= 0`),
    check(
      'tasks_completed_at_matches_status',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)`,
    ),
    check(
      'tasks_sequence_position_requires_sequence',
      sql`${table.sequencePosition} is null or ${table.sequenceId} is not null`,
    ),
  ],
);

/**
 * A concrete unit of demand to be placed (spec §4.3, §8.2).
 *
 * Every schedulable task has at least one occurrence — a non-recurring task has
 * exactly one with a NULL period, a recurring one gets a row per period. That
 * uniformity is deliberate: the scheduler and the placement cache only ever
 * deal in occurrences, so M14 adds rows rather than branches.
 */
export const taskOccurrences = pgTable(
  'task_occurrences',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull(),

    /** Half-open `[start, end)`. Both NULL for a non-recurring task's single occurrence. */
    periodStart: date('period_start'),
    periodEnd: date('period_end'),

    status: occurrenceStatus('status').notNull().default('pending'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),

    /**
     * Where this occurrence sat when it was completed (§3.4, §7.3).
     *
     * Copied off the placement cache at completion and kept here, because the
     * cache is replaced wholesale by every solve: a completed occurrence is no
     * longer demand, so the next re-derive would place it nowhere and the only
     * record of an afternoon's work would disappear from the week it was spent
     * in. "Done, then, there" is a fact about the past, so it lives in source
     * state rather than in something derived from it.
     *
     * Null for a completion that had no placement to record — a task finished
     * straight out of the backlog, or one completed before this column existed.
     */
    completedStart: timestamp('completed_start', { withTimezone: true, mode: 'string' }),
    completedEnd: timestamp('completed_end', { withTimezone: true, mode: 'string' }),

    /** Set when this occurrence carries an earlier period's unmet demand (§8.2). */
    rolledOverFromId: uuid('rolled_over_from_id'),

    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('task_occurrences_id_tenant_key').on(table.id, table.tenantId),
    foreignKey({
      columns: [table.taskId, table.tenantId],
      foreignColumns: [tasks.id, tasks.tenantId],
      name: 'task_occurrences_task_same_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rolledOverFromId, table.tenantId],
      foreignColumns: [table.id, table.tenantId],
      name: 'task_occurrences_rollover_same_tenant_fk',
    }).onDelete('set null'),

    // **Not** unique on (task, period). M2 assumed one occurrence per period
    // and the `recurrence_count` column two files up contradicted it in the
    // same breath: "3 with period `week` = exercise 3× per week" needs three
    // rows in one week, and a rollover needs to add a fourth to the next.
    // Dropped in M14 (migration 0007); the generator's top-up-to-target is what
    // keeps generation idempotent now, explicitly rather than by accident.
    //
    // The partial index for the non-recurring case stays: a task with no rule
    // has exactly one occurrence, and NULLs being distinct in a unique
    // constraint is why that needs an index of its own.
    index('task_occurrences_task_period_idx').on(table.taskId, table.periodStart),
    uniqueIndex('task_occurrences_one_per_non_recurring_task')
      .on(table.taskId)
      .where(sql`${table.periodStart} is null`),
    index('task_occurrences_status_idx').on(table.status),

    check(
      'task_occurrences_period_pair',
      sql`(${table.periodStart} is null) = (${table.periodEnd} is null)
          and (${table.periodStart} is null or ${table.periodStart} < ${table.periodEnd})`,
    ),
    check(
      'task_occurrences_completed_at_matches_status',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)`,
    ),
    check(
      'task_occurrences_completed_interval',
      sql`(${table.completedStart} is null) = (${table.completedEnd} is null)
          and (${table.completedStart} is null or ${table.completedStart} < ${table.completedEnd})`,
    ),
    check(
      'task_occurrences_completed_interval_needs_completion',
      sql`${table.completedStart} is null or ${table.status} = 'completed'`,
    ),
    index('task_occurrences_completed_start_idx').on(table.completedStart),
  ],
);

export type Sequence = typeof sequences.$inferSelect;
export type NewSequence = typeof sequences.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskOccurrence = typeof taskOccurrences.$inferSelect;
export type NewTaskOccurrence = typeof taskOccurrences.$inferInsert;
