import { inArray } from 'drizzle-orm';
import { ONE } from '@ambitime/scheduler';
import { tasks } from '../db/schema/index.js';
import { toIso } from '../schedule/instants.js';
import type { CapacityCell, Instant } from '@ambitime/scheduler';
import type { DerivedSchedule } from '../schedule/derive.js';
import type { Transaction } from '../db/client.js';
import type { Schedule, TaskNode } from '@ambitime/shared';
import type { TaskTreeNode } from '../tasks/task-tree.js';

/**
 * Turning what the engine produced into what a client can draw (spec §3.1).
 *
 * Two shifts happen here and nowhere else. Instants become **ISO-8601
 * strings**: the engine reasons in integer minutes since the epoch (§6.3), and
 * that is an internal representation, not a contract — an API that shipped
 * `29571300` would be asking every consumer to know the same secret. Fixed-point
 * scores become **plain ratios** for the same reason.
 *
 * And placements become blocks with titles. A `Placement` is an occurrence id
 * and an interval, which is everything a solver needs and nothing a calendar
 * needs. The join is done once, on the server, rather than in every consumer.
 */

export interface PresentInput {
  tx: Transaction;
  schedule: DerivedSchedule;
}

export async function presentSchedule({ tx, schedule }: PresentInput): Promise<Schedule> {
  const occurrences = new Map(
    schedule.context.schedulables.map((schedulable) => [schedulable.occurrenceId, schedulable]),
  );

  const taskIds = [...new Set([...occurrences.values()].map((s) => s.taskId))];
  const titles = await titlesOf(tx, taskIds);

  return {
    calendarId: schedule.calendarId,
    horizon: { start: toIso(schedule.horizon.start), end: toIso(schedule.horizon.end) },

    blocks: schedule.placements.map((placement) => {
      const schedulable = occurrences.get(placement.occurrenceId);
      return {
        occurrenceId: placement.occurrenceId,
        taskId: schedulable?.taskId ?? '',
        title: titles.get(schedulable?.taskId ?? '') ?? '',
        categoryId: schedulable?.categoryId ?? null,
        start: toIso(placement.interval.start),
        end: toIso(placement.interval.end),
        cooldownMin: placement.cooldownMin,
      };
    }),

    backlog: schedule.backlog.map((entry) => {
      const schedulable = occurrences.get(entry.occurrenceId);
      return {
        occurrenceId: entry.occurrenceId,
        taskId: schedulable?.taskId ?? '',
        title: titles.get(schedulable?.taskId ?? '') ?? '',
        estimatedWeek: entry.estimatedWeek,
        reason: entry.reason,
        sequenceId: entry.sequenceId ?? null,
      };
    }),

    diagnostics: schedule.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      occurrenceId: diagnostic.occurrenceId,
      taskId: diagnostic.taskId,
      message: diagnostic.message,
      ...(diagnostic.reason === undefined ? {} : { reason: diagnostic.reason }),
      ...(diagnostic.sequenceId === undefined ? {} : { sequenceId: diagnostic.sequenceId }),
      ...(diagnostic.estimatedWeek === undefined
        ? {}
        : { estimatedWeek: diagnostic.estimatedWeek }),
      ...(diagnostic.dueDate === undefined ? {} : { dueDate: toIso(diagnostic.dueDate) }),
    })),

    unschedulable: schedule.unschedulable.map((entry) => ({
      taskId: entry.taskId,
      occurrenceId: entry.occurrenceId,
      reason: entry.reason,
    })),
  };
}

/**
 * Fixed point out, plain ratio in.
 *
 * The engine compares integers so floating point can never decide a placement
 * (§6.3). A client reading a utilization indicator has no such requirement and
 * every reason to want `1.25` rather than `1_250_000`.
 */
export function presentCapacityCell(cell: CapacityCell) {
  return {
    calendarId: cell.calendarId,
    categoryId: cell.categoryId,
    weekStart: cell.weekStart,
    supplyMin: cell.supplyMin,
    demandMin: cell.demandMin,
    utilization: cell.utilization === null ? null : cell.utilization / ONE,
    status: cell.status,
    maxContiguousSpanMin: cell.maxContiguousSpanMin,
    longestSequenceMin: cell.longestSequenceMin,
    hasContiguousSpan: cell.hasContiguousSpan,
    reservedCooldownMin: cell.reservedCooldownMin,
  };
}

export function presentInterval(interval: { start: Instant; end: Instant }) {
  return { start: toIso(interval.start), end: toIso(interval.end) };
}

async function titlesOf(tx: Transaction, taskIds: string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();

  const rows = await tx
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(inArray(tasks.id, taskIds));

  return new Map(rows.map((row) => [row.id, row.title]));
}

/**
 * A task tree node, trimmed to the fields the API promises.
 *
 * The CTE returns more than the contract does — the preferred-range columns
 * among them — and passing rows through untouched would make every column an
 * accidental part of the contract.
 */
export function presentTaskNode(node: TaskTreeNode): TaskNode {
  return {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    depth: node.depth,
    path: node.path,
    isLeaf: node.isLeaf,
    status: node.status,
    estimatedDurationMin: node.estimatedDurationMin,
    ownCategoryId: node.ownCategoryId,
    effectiveCategoryId: node.effectiveCategoryId,
    ownPriority: node.ownPriority,
    effectivePriority: node.effectivePriority,
    ownDueDate: isoOrNull(node.ownDueDate),
    effectiveDueDate: isoOrNull(node.effectiveDueDate),
    ownDueKind: node.ownDueKind,
    effectiveDueKind: node.effectiveDueKind,
    ownFocusLevel: node.ownFocusLevel,
    effectiveFocusLevel: node.effectiveFocusLevel,
    ownCooldownOverrideMin: node.ownCooldownOverrideMin,
    effectiveCooldownOverrideMin: node.effectiveCooldownOverrideMin,
  };
}

/**
 * Postgres's `timestamptz` text, as ISO-8601.
 *
 * The task tree is a hand-written CTE read through `execute`, so its timestamps
 * arrive in the driver's own format (`2026-04-01 12:00:00+00`) rather than
 * through Drizzle's column mapping. Normalised here, at the presentation
 * boundary, rather than in the CTE — M2 owns that query's shape, and the API
 * owns the format it promises.
 */
function isoOrNull(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
