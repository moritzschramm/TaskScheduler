import { byId, chain, descending, byInt, sorted } from './ordering.js';
import { DEFAULT_TUNING, type TuningConfig } from './config.js';
import type { DiagnosticSeverity } from './diagnostics.js';
import type { Instant } from './time.js';

/**
 * Chronic postponement (spec §6.6).
 *
 * The spec is emphatic that this is a **distinct signal** from capacity: a
 * category being overcommitted is a fact about the calendar, while a task the
 * user keeps pushing is a fact about the task. Conflating them buries the more
 * interesting one — "you are trying to do too much this week" is routine, "this
 * particular thing has been postponed five times" is a prompt to drop it,
 * delegate it, or admit it is not going to happen.
 *
 * The other separation the spec insists on is between **user-initiated
 * deferrals and involuntary reflows**. A task moved eight times by the sick-day
 * bulk action has not been avoided by anyone; counting those would fire the
 * signal on precisely the tasks the user is least responsible for. Only
 * `deferCount` and estimated-week slippage feed the threshold; `reflowCount` is
 * carried through for display and never triggers.
 *
 * A pure function over task metadata, deliberately independent of any schedule:
 * the history lives on the task (§4.4) and the signal can be recomputed without
 * solving anything.
 */

/** The deferral metadata a task carries (spec §4.4). */
export interface DeferralHistory {
  taskId: string;
  /** Present when the history is tracked per occurrence rather than per task. */
  occurrenceId?: string;
  /** Postponements the user asked for (§7.3). */
  deferCount: number;
  /** Re-placements the engine made on the user's behalf (§7.2). Never triggers. */
  reflowCount?: number;
  /** Times the task aged past the estimated week it had been given (§6.1). */
  estimatedWeekMisses?: number;
  lastDeferReason?: string;
  lastDeferAt?: Instant;
}

/** Which of §6.6's two conditions fired. Both may. */
export type DeferralTrigger = 'defer_count' | 'estimated_week_slippage';

export interface DeferralSignal {
  code: 'chronic_postponement';
  severity: DiagnosticSeverity;
  taskId: string;
  occurrenceId?: string;
  /** In a stable order, so two runs produce identical signals (§6.3). */
  triggers: DeferralTrigger[];
  deferCount: number;
  reflowCount: number;
  estimatedWeekMisses: number;
  /** The `N` in force when this was computed, so the message can be explained. */
  threshold: number;
  lastDeferReason?: string;
  lastDeferAt?: Instant;
  message: string;
}

/**
 * The signal for one task, or `undefined` when it is not chronic.
 *
 * §6.6 gives two conditions — "deferred ≥ N times, or aging past its estimated
 * week repeatedly" — and §15 names a single threshold `N`, so one threshold
 * governs both. Reporting which condition fired matters: a task deferred by
 * hand is being avoided, while one that keeps slipping its estimated week is
 * being crowded out, and those call for different responses.
 */
export function assessDeferral(
  history: DeferralHistory,
  config: TuningConfig = DEFAULT_TUNING,
): DeferralSignal | undefined {
  const threshold = config.chronicPostponementThreshold;
  const deferCount = Math.max(0, history.deferCount);
  const reflowCount = Math.max(0, history.reflowCount ?? 0);
  const estimatedWeekMisses = Math.max(0, history.estimatedWeekMisses ?? 0);

  // A non-positive threshold would fire on every task ever created, which is
  // indistinguishable from the feature being broken.
  if (threshold <= 0) return undefined;

  const triggers: DeferralTrigger[] = [];
  if (deferCount >= threshold) triggers.push('defer_count');
  if (estimatedWeekMisses >= threshold) triggers.push('estimated_week_slippage');

  if (triggers.length === 0) return undefined;

  return {
    code: 'chronic_postponement',
    severity: 'warning',
    taskId: history.taskId,
    ...(history.occurrenceId === undefined ? {} : { occurrenceId: history.occurrenceId }),
    triggers,
    deferCount,
    reflowCount,
    estimatedWeekMisses,
    threshold,
    ...(history.lastDeferReason === undefined ? {} : { lastDeferReason: history.lastDeferReason }),
    ...(history.lastDeferAt === undefined ? {} : { lastDeferAt: history.lastDeferAt }),
    message: describe(history.taskId, triggers, deferCount, estimatedWeekMisses, history),
  };
}

/**
 * Every task whose history is chronic, worst first.
 *
 * Ordered by deferral count then slippage then task id — a total order, so the
 * list a user sees is the same on every recomputation (§6.3).
 */
export function assessDeferrals(
  histories: readonly DeferralHistory[],
  config: TuningConfig = DEFAULT_TUNING,
): DeferralSignal[] {
  const signals = histories
    .map((history) => assessDeferral(history, config))
    .filter((signal): signal is DeferralSignal => signal !== undefined);

  return sorted(
    signals,
    chain<DeferralSignal>(
      descending(byInt((signal) => signal.deferCount)),
      descending(byInt((signal) => signal.estimatedWeekMisses)),
      byId((signal) => signal.taskId),
      byId((signal) => signal.occurrenceId ?? ''),
    ),
  );
}

function describe(
  taskId: string,
  triggers: readonly DeferralTrigger[],
  deferCount: number,
  estimatedWeekMisses: number,
  history: DeferralHistory,
): string {
  const parts: string[] = [];
  if (triggers.includes('defer_count')) {
    parts.push(`postponed ${deferCount} times`);
  }
  if (triggers.includes('estimated_week_slippage')) {
    parts.push(`slipped its estimated week ${estimatedWeekMisses} times`);
  }

  const reason =
    history.lastDeferReason === undefined ? '' : ` Last reason: ${history.lastDeferReason}.`;

  return `Task ${taskId} keeps getting pushed: ${parts.join(' and ')}.${reason}`;
}
