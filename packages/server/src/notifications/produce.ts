import { and, eq, inArray, isNull, like, notInArray } from 'drizzle-orm';
import { assessDeferrals, type DeferralHistory, type Diagnostic } from '@ambitime/scheduler';
import {
  calendars,
  calendarWindows,
  notifications,
  tasks,
  teamMemberships,
  teamWindows,
} from '../db/schema/index.js';
import type { DerivedSchedule } from '../schedule/derive.js';
import type { TuningConfig } from '@ambitime/scheduler';
import type { Transaction } from '../db/client.js';
import type {
  NewNotification,
  NotificationSeverity,
  NotificationType,
} from '../db/schema/index.js';

/**
 * Turning the engine's signals into notifications (spec §6.6, §6.7, §11).
 *
 * **Nothing here decides anything.** Every signal is read off what the
 * scheduler already produced — a `Diagnostic` from the solve, a `DeferralSignal`
 * from `assessDeferrals` — and mapped onto a row. A second opinion about
 * whether a due date is at risk would be a second scheduler, and the two would
 * disagree the first time a weight changed (§6.5).
 *
 * **Signals are derived state, not a log.** "This task will miss its hard due
 * date" is true until it is not, so the set is *replaced* on every write rather
 * than appended to: a row per re-derive would bury the user in copies of one
 * fact, and a signal that stopped being true would sit there for ever claiming
 * otherwise. That is §3.4's pattern applied to notifications, and it is why the
 * dedupe key exists.
 *
 * An **event** — an internal appointment changed under you (§7.2) — carries no
 * dedupe key and is never recomputed away. It happened; it does not stop having
 * happened.
 *
 * Produced on the **write path only**. A signal that becomes true purely
 * because time passed — a due date that arrives while nobody is looking — needs
 * a job to notice it, and jobs are M15 (§11).
 */

/** Which notification type and severity each diagnostic becomes (§6.5, §6.7). */
const FROM_DIAGNOSTIC: Readonly<
  Record<Diagnostic['code'], { type: NotificationType; severity: NotificationSeverity }>
> = {
  // §6.7: a backlogged task is "a passive backlog entry" — informational.
  backlogged: { type: 'backlog_added', severity: 'info' },
  // §6.5: a soft due date warns.
  soft_due_date_at_risk: { type: 'due_date_at_risk', severity: 'warning' },
  // §6.7: "if it carries a due date or hard constraint at risk, an **alert** is
  // raised (not merely a passive backlog entry)".
  hard_due_date_at_risk: { type: 'hard_constraint_conflict', severity: 'alert' },
};

export interface ProduceInput {
  tx: Transaction;
  tenantId: string;
  userId: string;
  derived: DerivedSchedule;
  config: TuningConfig;
}

interface Signal {
  key: string;
  type: NotificationType;
  severity: NotificationSeverity;
  payload: Record<string, unknown>;
}

/**
 * Recomputes this calendar's signals for one user and writes the difference.
 *
 * Scoped by the calendar id the keys are prefixed with, so producing for one
 * calendar cannot clear another's — a user with a work calendar and a personal
 * one has two independent sets of signals, and a command against one says
 * nothing about the other.
 */
export async function produceSignals({
  tx,
  tenantId,
  userId,
  derived,
  config,
}: ProduceInput): Promise<void> {
  const signals = [
    ...fromDiagnostics(derived),
    ...(await fromDeferrals(tx, derived, config)),
    ...(await fromWindowDivergence(tx, derived.calendarId)),
  ].map((signal) => ({ ...signal, key: `${derived.calendarId}|${signal.key}` }));

  const scope = `${derived.calendarId}|%`;
  const live = signals.map((signal) => signal.key);

  // Gone means no longer true. Removed rather than marked resolved: an unread
  // notification is a claim about now, and one nobody has read yet has no
  // history worth keeping.
  await tx
    .delete(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        like(notifications.dedupeKey, scope),
        ...(live.length === 0 ? [] : [notInArray(notifications.dedupeKey, live)]),
      ),
    );

  if (signals.length === 0) return;

  // Still true and already raised stays as it is, keeping its `created_at` —
  // "since when" is the useful part of a standing warning.
  await tx
    .insert(notifications)
    .values(
      signals.map((signal): NewNotification => ({
        tenantId,
        userId,
        type: signal.type,
        severity: signal.severity,
        payload: signal.payload,
        dedupeKey: signal.key,
      })),
    )
    .onConflictDoNothing();
}

/**
 * The solve's own diagnostics, mapped (spec §6.7).
 *
 * Members of a sequence are collapsed onto the sequence: §6.4 makes it one
 * uninterruptible block, so "these five things are at risk" is one fact about
 * one thing, and five notifications about it would be five ways of saying it.
 */
function fromDiagnostics(derived: DerivedSchedule): Signal[] {
  const seen = new Set<string>();
  const signals: Signal[] = [];

  for (const diagnostic of derived.diagnostics) {
    const mapping = FROM_DIAGNOSTIC[diagnostic.code];
    const subject = diagnostic.sequenceId ?? diagnostic.taskId;
    const key = `${diagnostic.code}|${subject}`;
    if (seen.has(key)) continue;
    seen.add(key);

    signals.push({
      key,
      type: mapping.type,
      severity: mapping.severity,
      payload: {
        calendarId: derived.calendarId,
        code: diagnostic.code,
        taskId: diagnostic.taskId,
        message: diagnostic.message,
        ...(diagnostic.sequenceId === undefined ? {} : { sequenceId: diagnostic.sequenceId }),
        ...(diagnostic.reason === undefined ? {} : { reason: diagnostic.reason }),
        ...(diagnostic.estimatedWeek === undefined
          ? {}
          : { estimatedWeek: diagnostic.estimatedWeek }),
      },
    });
  }

  return signals;
}

/**
 * Chronic postponement (spec §6.6) — a distinct signal from overcommitment.
 *
 * "A task repeatedly postponed **by the user** is a distinct signal." The
 * threshold and both of its conditions live in `assessDeferrals`; this only
 * supplies the counts and files what comes back.
 */
async function fromDeferrals(
  tx: Transaction,
  derived: DerivedSchedule,
  config: TuningConfig,
): Promise<Signal[]> {
  const taskIds = derived.context.schedulables.map((schedulable) => schedulable.taskId);
  if (taskIds.length === 0) return [];

  const rows = await tx
    .select({
      taskId: tasks.id,
      title: tasks.title,
      deferCount: tasks.deferCount,
      lastDeferReason: tasks.lastDeferReason,
    })
    .from(tasks)
    .where(and(eq(tasks.calendarId, derived.calendarId), inArray(tasks.id, taskIds)));

  const histories: DeferralHistory[] = rows.map((row) => ({
    taskId: row.taskId,
    deferCount: row.deferCount,
    ...(row.lastDeferReason === null ? {} : { lastDeferReason: row.lastDeferReason }),
  }));

  const titles = new Map(rows.map((row) => [row.taskId, row.title]));

  return assessDeferrals(histories, config).map((signal) => {
    const title = titles.get(signal.taskId) ?? null;

    return {
      key: `chronic_postponement|${signal.taskId}`,
      type: 'chronic_postponement' as const,
      severity: signal.severity,
      payload: {
        calendarId: derived.calendarId,
        taskId: signal.taskId,
        title,
        triggers: signal.triggers,
        deferCount: signal.deferCount,
        threshold: signal.threshold,
        // The engine names the task by id, because it has never been told
        // anything else about it. Naming it by title is presentation, not a
        // second opinion — every number in the sentence is the engine's.
        message:
          title === null
            ? signal.message
            : `"${title}" keeps getting pushed: postponed ${signal.deferCount} times.`,
        engineMessage: signal.message,
      },
    };
  });
}

/**
 * Spec §9.4 — "if a user's working window diverges from their team's working
 * window, notify the user".
 *
 * Compared as sets of weekday ranges, which is why `team_windows` has the same
 * shape as `calendar_windows`: converting one into the other before every
 * comparison is where the drift would live.
 *
 * A calendar with **no** working window does not diverge. Unset means
 * unrestricted rather than empty (§9.1), and telling somebody their unset
 * window disagrees with their team's would be a notice about nothing.
 */
async function fromWindowDivergence(tx: Transaction, calendarId: string): Promise<Signal[]> {
  const [calendar] = await tx
    .select({ ownerId: calendars.ownerId, name: calendars.name })
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .limit(1);

  if (!calendar) return [];

  const mine = await tx
    .select({
      weekday: calendarWindows.weekday,
      startMin: calendarWindows.startMin,
      endMin: calendarWindows.endMin,
    })
    .from(calendarWindows)
    .where(and(eq(calendarWindows.calendarId, calendarId), eq(calendarWindows.kind, 'working')));

  if (mine.length === 0) return [];

  const teams = await tx
    .select({
      teamId: teamWindows.teamId,
      weekday: teamWindows.weekday,
      startMin: teamWindows.startMin,
      endMin: teamWindows.endMin,
    })
    .from(teamWindows)
    .innerJoin(teamMemberships, eq(teamMemberships.teamId, teamWindows.teamId))
    .where(eq(teamMemberships.userId, calendar.ownerId));

  const byTeam = new Map<string, { weekday: number; startMin: number; endMin: number }[]>();
  for (const row of teams) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push({ weekday: row.weekday, startMin: row.startMin, endMin: row.endMin });
    byTeam.set(row.teamId, list);
  }

  const signals: Signal[] = [];
  for (const [teamId, theirs] of byTeam) {
    if (sameWindow(mine, theirs)) continue;

    signals.push({
      key: `working_window_divergence|${teamId}`,
      type: 'working_window_divergence',
      severity: 'info',
      payload: {
        calendarId,
        calendarName: calendar.name,
        teamId,
        message: `Your working window on "${calendar.name}" differs from your team's.`,
      },
    });
  }

  return signals;
}

/** Two weekday-range sets, compared without caring what order they arrived in. */
function sameWindow(
  a: readonly { weekday: number; startMin: number; endMin: number }[],
  b: readonly { weekday: number; startMin: number; endMin: number }[],
): boolean {
  const key = (ranges: readonly { weekday: number; startMin: number; endMin: number }[]) =>
    ranges
      .map((range) => `${range.weekday}:${range.startMin}-${range.endMin}`)
      .sort()
      .join('|');

  return key(a) === key(b);
}

/** Kept for the M15 job that will mark a signal delivered. */
export const SIGNAL_SCOPE = (calendarId: string): string => `${calendarId}|%`;
