import { sql } from 'drizzle-orm';
import type { Transaction } from '../db/client.js';

/**
 * A task with its inherited properties already resolved.
 *
 * `effective*` fields apply spec §4.4's nearest-ancestor-wins rule: the value
 * set on this task if it has one, otherwise the closest ancestor's. `own*`
 * fields are kept alongside so the UI can distinguish an inherited value from a
 * local override — the affordance M11 needs.
 */
export interface TaskTreeNode extends Record<string, unknown> {
  id: string;
  parentId: string | null;
  calendarId: string;
  title: string;
  notes: string | null;
  depth: number;
  /** Ancestor ids from the root down to and including this node. */
  path: string[];
  /** Only leaves are placed by the scheduler (spec §4.4). */
  isLeaf: boolean;
  status: 'active' | 'completed' | 'cancelled';
  /** The optimistic lock an editor sends back with its patch (spec §5.4). */
  version: number;
  estimatedDurationMin: number | null;

  ownActivityTypeId: string | null;
  effectiveActivityTypeId: string | null;
  ownPriority: number | null;
  effectivePriority: number | null;
  ownDueDate: string | null;
  effectiveDueDate: string | null;
  ownDueKind: 'soft' | 'hard' | null;
  effectiveDueKind: 'soft' | 'hard' | null;
  ownPreferredStartMin: number | null;
  effectivePreferredStartMin: number | null;
  ownPreferredEndMin: number | null;
  effectivePreferredEndMin: number | null;
  ownFocusLevel: number | null;
  effectiveFocusLevel: number | null;
  ownCooldownOverrideMin: number | null;
  effectiveCooldownOverrideMin: number | null;
  /** Not inherited: a floor is something done to one task (spec §7.3). */
  manualFloor: string | null;
  manualBias: string | null;
  /** The demand rule of §8.2. Not inherited: a subtask is not the recurrence. */
  recurrencePeriod: 'day' | 'week' | 'month' | null;
  recurrenceCount: number | null;
  missedOccurrencePolicy: 'rollover' | 'expire';
}

/**
 * The inheritable set from spec §4.4. Due date and due kind travel together:
 * a kind belongs to the date it qualifies, so inheriting one without the other
 * would produce a due date whose enforcement is undefined.
 */
const inheritedColumns = sql`
  coalesce(t.activity_type_id, p.effective_activity_type_id) as effective_activity_type_id,
  coalesce(t.priority, p.effective_priority) as effective_priority,
  coalesce(t.due_date, p.effective_due_date) as effective_due_date,
  case when t.due_date is not null then t.due_kind else p.effective_due_kind end
    as effective_due_kind,
  coalesce(t.preferred_start_min, p.effective_preferred_start_min)
    as effective_preferred_start_min,
  coalesce(t.preferred_end_min, p.effective_preferred_end_min)
    as effective_preferred_end_min,
  coalesce(t.focus_level, p.effective_focus_level) as effective_focus_level,
  coalesce(t.cooldown_override_min, p.effective_cooldown_override_min)
    as effective_cooldown_override_min
`;

const selectedColumns = sql`
  n.id,
  n.parent_id            as "parentId",
  n.calendar_id          as "calendarId",
  n.title,
  n.notes,
  n.depth,
  n.path,
  n.status,
  n.version,
  n.estimated_duration_min as "estimatedDurationMin",
  not exists (select 1 from tasks c where c.parent_id = n.id) as "isLeaf",
  n.activity_type_id          as "ownActivityTypeId",
  n.effective_activity_type_id as "effectiveActivityTypeId",
  n.priority             as "ownPriority",
  n.effective_priority   as "effectivePriority",
  n.due_date             as "ownDueDate",
  n.effective_due_date   as "effectiveDueDate",
  n.due_kind             as "ownDueKind",
  n.effective_due_kind   as "effectiveDueKind",
  n.preferred_start_min  as "ownPreferredStartMin",
  n.effective_preferred_start_min as "effectivePreferredStartMin",
  n.preferred_end_min    as "ownPreferredEndMin",
  n.effective_preferred_end_min as "effectivePreferredEndMin",
  n.focus_level          as "ownFocusLevel",
  n.effective_focus_level as "effectiveFocusLevel",
  n.cooldown_override_min as "ownCooldownOverrideMin",
  n.effective_cooldown_override_min as "effectiveCooldownOverrideMin",
  n.manual_floor         as "manualFloor",
  n.manual_bias          as "manualBias",
  n.recurrence_period    as "recurrencePeriod",
  n.recurrence_count     as "recurrenceCount",
  n.missed_occurrence_policy as "missedOccurrencePolicy"
`;

/**
 * Reads every task tree in a calendar, resolving inheritance on the way down.
 *
 * The recursion *is* the inheritance: each level coalesces its own value against
 * the one already computed for its parent, which is precisely
 * nearest-ancestor-wins. Doing it in one pass avoids the N ancestor walks a
 * per-row resolution would cost.
 *
 * Ordered by materialised path, so parents always precede their children and
 * siblings keep a stable order — what a tree view can render directly.
 *
 * Runs inside the caller's transaction, so RLS scopes it to the active tenant.
 */
export async function readCalendarTaskTree(
  tx: Transaction,
  calendarId: string,
): Promise<TaskTreeNode[]> {
  const rows = await tx.execute<TaskTreeNode>(sql`
    with recursive tree as (
      select
        t.id, t.parent_id, t.calendar_id, t.title, t.notes, t.depth, t.status,
        t.version, t.estimated_duration_min, t.manual_floor, t.manual_bias,
        t.recurrence_period, t.recurrence_count, t.missed_occurrence_policy,
        t.activity_type_id, t.priority, t.due_date, t.due_kind,
        t.preferred_start_min, t.preferred_end_min, t.focus_level,
        t.cooldown_override_min,
        t.activity_type_id           as effective_activity_type_id,
        t.priority              as effective_priority,
        t.due_date              as effective_due_date,
        t.due_kind              as effective_due_kind,
        t.preferred_start_min   as effective_preferred_start_min,
        t.preferred_end_min     as effective_preferred_end_min,
        t.focus_level           as effective_focus_level,
        t.cooldown_override_min as effective_cooldown_override_min,
        array[t.id]             as path
      from tasks t
      where t.calendar_id = ${calendarId}
        and t.parent_id is null

      union all

      select
        t.id, t.parent_id, t.calendar_id, t.title, t.notes, t.depth, t.status,
        t.version, t.estimated_duration_min, t.manual_floor, t.manual_bias,
        t.recurrence_period, t.recurrence_count, t.missed_occurrence_policy,
        t.activity_type_id, t.priority, t.due_date, t.due_kind,
        t.preferred_start_min, t.preferred_end_min, t.focus_level,
        t.cooldown_override_min,
        ${inheritedColumns},
        p.path || t.id
      from tasks t
      join tree p on t.parent_id = p.id
    )
    select ${selectedColumns}
      from tree n
     order by n.path
  `);

  return [...rows];
}

/**
 * Reads one subtree, seeded with what the root inherits from *its* ancestors.
 *
 * Without that seed a subtree read would report the root's inherited values as
 * NULL and silently differ from the same node's row in a full-tree read. `path`
 * stays absolute for the same reason: a node should describe itself identically
 * however it was reached.
 */
export async function readTaskSubtree(
  tx: Transaction,
  rootTaskId: string,
): Promise<TaskTreeNode[]> {
  const rows = await tx.execute<TaskTreeNode>(sql`
    with recursive
    -- Walk up from the root, collecting each ancestor's own values. The
    -- steps counter orders them by proximity, which is what turns
    -- "nearest ancestor wins" into a LIMIT 1.
    ancestry as (
      select t.id, t.parent_id, t.activity_type_id, t.priority, t.due_date, t.due_kind,
             t.preferred_start_min, t.preferred_end_min, t.focus_level,
             t.cooldown_override_min, 0 as steps
        from tasks t
       where t.id = ${rootTaskId}
      union all
      select a2.id, a2.parent_id, a2.activity_type_id, a2.priority, a2.due_date, a2.due_kind,
             a2.preferred_start_min, a2.preferred_end_min, a2.focus_level,
             a2.cooldown_override_min, a.steps + 1
        from tasks a2
        join ancestry a on a2.id = a.parent_id
       where a.steps < 5
    ),
    seed as (
      select
        (select activity_type_id from ancestry where activity_type_id is not null
          order by steps limit 1) as effective_activity_type_id,
        (select priority from ancestry where priority is not null
          order by steps limit 1) as effective_priority,
        (select due_date from ancestry where due_date is not null
          order by steps limit 1) as effective_due_date,
        (select due_kind from ancestry where due_date is not null
          order by steps limit 1) as effective_due_kind,
        (select preferred_start_min from ancestry where preferred_start_min is not null
          order by steps limit 1) as effective_preferred_start_min,
        (select preferred_end_min from ancestry where preferred_end_min is not null
          order by steps limit 1) as effective_preferred_end_min,
        (select focus_level from ancestry where focus_level is not null
          order by steps limit 1) as effective_focus_level,
        (select cooldown_override_min from ancestry where cooldown_override_min is not null
          order by steps limit 1) as effective_cooldown_override_min,
        -- The root's absolute path, outermost ancestor first, so a node reports
        -- the same path here as it does in a full-tree read.
        (select array_agg(id order by steps desc) from ancestry) as root_path
    ),
    tree as (
      select
        t.id, t.parent_id, t.calendar_id, t.title, t.notes, t.depth, t.status,
        t.version, t.estimated_duration_min, t.manual_floor, t.manual_bias,
        t.recurrence_period, t.recurrence_count, t.missed_occurrence_policy,
        t.activity_type_id, t.priority, t.due_date, t.due_kind,
        t.preferred_start_min, t.preferred_end_min, t.focus_level,
        t.cooldown_override_min,
        s.effective_activity_type_id, s.effective_priority,
        s.effective_due_date, s.effective_due_kind,
        s.effective_preferred_start_min, s.effective_preferred_end_min,
        s.effective_focus_level, s.effective_cooldown_override_min,
        s.root_path as path
      from tasks t
      cross join seed s
      where t.id = ${rootTaskId}

      union all

      select
        t.id, t.parent_id, t.calendar_id, t.title, t.notes, t.depth, t.status,
        t.version, t.estimated_duration_min, t.manual_floor, t.manual_bias,
        t.recurrence_period, t.recurrence_count, t.missed_occurrence_policy,
        t.activity_type_id, t.priority, t.due_date, t.due_kind,
        t.preferred_start_min, t.preferred_end_min, t.focus_level,
        t.cooldown_override_min,
        ${inheritedColumns},
        p.path || t.id
      from tasks t
      join tree p on t.parent_id = p.id
    )
    select ${selectedColumns}
      from tree n
     order by n.path
  `);

  return [...rows];
}
