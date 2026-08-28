import { byId, byInt, chain, descending, sorted } from '../ordering.js';
import { DEFAULT_TUNING, type TuningConfig } from '../config.js';
import { computeHardHorizon } from '../horizon.js';
import { eligibleWindows } from '../windows.js';
import { defaultScoringPolicy } from '../scoring/default-policy.js';
import {
  assertPolicyMatchesWeights,
  orderScore,
  slotScore,
  type ScoringPolicy,
} from '../scoring/policy.js';
import { candidateIntervals, occupiedWithin, type OccupiedFootprint } from './slots.js';
import { assignBacklogWeeks, type BacklogEntry, type UnplacedTask } from '../backlog.js';
import type { CompositeScore } from '../fixed-point.js';
import type { Diagnostic, InfeasibilityReason } from '../diagnostics.js';
import type { Interval } from '../time.js';
import type {
  CalendarSpec,
  Placement,
  ResolvedWindow,
  Schedulable,
  ScheduleContext,
} from '../types.js';

/**
 * The greedy solver (spec §6.5).
 *
 * Two stages: stage 1 decides which task chooses first, stage 2 decides which
 * slot it takes. Both are pure ranking over candidates that have *already*
 * passed every hard filter in `slots.ts`. That ordering is the point — it makes
 * "soft constraints never override hard ones" structural rather than a property
 * of how the weights happen to be set. No weighting of the scoring terms can
 * produce an invalid placement, because invalid slots are never scored.
 *
 * A task with no feasible slot is never placed illegally: it goes to the
 * backlog with a named reason (§6.7).
 */

export interface SolveOptions {
  policy?: ScoringPolicy;
  config?: TuningConfig;
}

export interface SolveResult {
  placements: Placement[];
  backlog: BacklogEntry[];
  diagnostics: Diagnostic[];
  /** The hard horizon actually used, for callers rendering the result. */
  horizon: Interval;
}

export function solve(context: ScheduleContext, options: SolveOptions = {}): SolveResult {
  const config = options.config ?? DEFAULT_TUNING;
  const policy = options.policy ?? defaultScoringPolicy;
  assertPolicyMatchesWeights(policy, config);

  const calendars = new Map(context.calendars.map((calendar) => [calendar.id, calendar]));
  const horizon = resolveHorizon(context, calendars, config);

  // Only windows inside the hard horizon are placeable; anything beyond it
  // belongs to the coarse weekly planner (§6.1).
  const windows = context.windows.filter(
    (window) => window.interval.start < horizon.end && window.interval.end > horizon.start,
  );

  const feasibleMinutes = feasibleMinutesByCategory(windows);

  // Stage 1 — placement order: descending score, then the spec's tie-break of
  // earlier due date, higher priority, smaller id (§6.5).
  const ordered = sorted(
    context.schedulables,
    chain<Schedulable>(
      descending(
        byInt((schedulable) =>
          orderScore(policy, config, {
            schedulable,
            now: context.now,
            horizon,
            feasibleWindowMinutes: feasibleMinutes.get(categoryKey(schedulable)) ?? 0,
            config,
          }),
        ),
      ),
      byInt((schedulable) => schedulable.dueDate ?? Number.MAX_SAFE_INTEGER),
      descending(byInt((schedulable) => schedulable.priority ?? 0)),
      byId((schedulable) => schedulable.occurrenceId),
    ),
  );

  const occupied: OccupiedFootprint[] = context.fixedBlocks.map((block) => ({
    interval: block.interval,
  }));
  const placements: Placement[] = [];
  const unplaced: UnplacedTask[] = [];

  for (const schedulable of ordered) {
    const best = chooseSlot(schedulable, windows, occupied, calendars, policy, config, horizon);

    if (!best) {
      unplaced.push({ schedulable, reason: diagnoseInfeasibility(schedulable, windows, horizon) });
      continue;
    }

    placements.push({
      occurrenceId: schedulable.occurrenceId,
      interval: best.interval,
      cooldownMin: schedulable.cooldownMin,
    });
    // The committed footprint includes the cooldown, so later tasks avoid it
    // (§6.2 rule 3).
    occupied.push({
      interval: { start: best.interval.start, end: best.interval.end + schedulable.cooldownMin },
      occurrenceId: schedulable.occurrenceId,
    });
  }

  const backlog = assignBacklogWeeks(unplaced, { ...context, horizon }, config);

  return {
    placements: sorted(
      placements,
      chain(
        byInt((p: Placement) => p.interval.start),
        byId((p: Placement) => p.occurrenceId),
      ),
    ),
    backlog,
    diagnostics: buildDiagnostics(placements, backlog, context),
    horizon,
  };
}

/** Uses the caller's horizon when it gave one, otherwise derives it from `now`. */
function resolveHorizon(
  context: ScheduleContext,
  calendars: ReadonlyMap<string, CalendarSpec>,
  config: TuningConfig,
): Interval {
  if (context.horizon.end > context.horizon.start) return context.horizon;

  const timeZone = calendars.values().next().value?.timeZone ?? 'UTC';
  return computeHardHorizon(context.now, timeZone, config);
}

function categoryKey(schedulable: Schedulable): string {
  return `${schedulable.calendarId} ${schedulable.categoryId}`;
}

function feasibleMinutesByCategory(windows: readonly ResolvedWindow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const window of windows) {
    const key = `${window.calendarId} ${window.categoryId}`;
    totals.set(key, (totals.get(key) ?? 0) + (window.interval.end - window.interval.start));
  }
  return totals;
}

interface ScoredSlot {
  interval: Interval;
  score: CompositeScore;
}

/**
 * Stage 2 — the best slot for one task.
 *
 * Every candidate reaching here already satisfies the hard constraints, so this
 * is pure preference. Ties break by earliest start, then window rule id (§6.5).
 */
function chooseSlot(
  schedulable: Schedulable,
  windows: readonly ResolvedWindow[],
  occupied: readonly OccupiedFootprint[],
  calendars: ReadonlyMap<string, CalendarSpec>,
  policy: ScoringPolicy,
  config: TuningConfig,
  horizon: Interval,
): ScoredSlot | undefined {
  const calendar = calendars.get(schedulable.calendarId);
  if (!calendar) return undefined;

  let best: ScoredSlot | undefined;
  let bestKey: SlotKey | undefined;

  for (const window of eligibleWindows(windows, schedulable.calendarId, schedulable.categoryId)) {
    const within = occupiedWithin(window.interval, occupied);
    const occupiedIntervals = within.map((block) => block.interval);

    for (const interval of candidateIntervals({
      schedulable,
      window: window.interval,
      occupied: within,
      config,
    })) {
      const score = slotScore(policy, config, {
        schedulable,
        candidate: interval,
        cooldownMin: schedulable.cooldownMin,
        window,
        calendar,
        horizon,
        occupied: occupiedIntervals,
        config,
      });

      // An explicit key rather than "first one wins", so the tie-break is the
      // spec's and not an accident of generation order (§6.3).
      const key: SlotKey = [-score, interval.start, window.ruleId];
      if (bestKey === undefined || compareSlotKeys(key, bestKey) < 0) {
        best = { interval, score };
        bestKey = key;
      }
    }
  }

  return best;
}

type SlotKey = [negatedScore: number, start: number, ruleId: string];

function compareSlotKeys(a: SlotKey, b: SlotKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

/**
 * Names why a task could not be placed (spec §6.7).
 *
 * Distinguishing these matters: "this category has no windows" and "the week is
 * full" call for entirely different responses from the user.
 */
function diagnoseInfeasibility(
  schedulable: Schedulable,
  windows: readonly ResolvedWindow[],
  horizon: Interval,
): InfeasibilityReason {
  const candidates = eligibleWindows(windows, schedulable.calendarId, schedulable.categoryId);
  if (candidates.length === 0) return 'no_feasible_window';

  if (schedulable.manualFloor !== undefined && schedulable.manualFloor >= horizon.end) {
    return 'manual_floor_beyond_horizon';
  }

  if (schedulable.dueKind === 'hard' && schedulable.dueDate !== undefined) {
    const earliest = Math.min(...candidates.map((window) => window.interval.start));
    const floor = Math.max(earliest, schedulable.manualFloor ?? earliest);
    if (floor + schedulable.durationMin > schedulable.dueDate) {
      return 'hard_due_date_unreachable';
    }
  }

  // A big enough window exists in principle, so what is missing is free time.
  return 'insufficient_remaining_capacity';
}

/**
 * The post-placement due-date pass (spec §6.5).
 *
 * Deliberately independent of scoring: the spec requires every task placed
 * after its due date, and every task that could not be placed before it, to be
 * flagged *regardless of how scoring resolved*. Soft due dates warn, hard ones
 * alert (§6.7, §11).
 */
function buildDiagnostics(
  placements: readonly Placement[],
  backlog: readonly BacklogEntry[],
  context: ScheduleContext,
): Diagnostic[] {
  const schedulables = new Map(context.schedulables.map((s) => [s.occurrenceId, s]));
  const diagnostics: Diagnostic[] = [];

  for (const placement of placements) {
    const schedulable = schedulables.get(placement.occurrenceId);
    if (schedulable?.dueDate === undefined) continue;
    if (placement.interval.end <= schedulable.dueDate) continue;

    const hard = schedulable.dueKind === 'hard';
    diagnostics.push({
      code: hard ? 'hard_due_date_at_risk' : 'soft_due_date_at_risk',
      severity: hard ? 'alert' : 'warning',
      occurrenceId: placement.occurrenceId,
      taskId: schedulable.taskId,
      dueDate: schedulable.dueDate,
      message: `Task ${schedulable.taskId} is placed until ${placement.interval.end}, past its ${hard ? 'hard' : 'soft'} due date at ${schedulable.dueDate}.`,
    });
  }

  for (const entry of backlog) {
    const schedulable = schedulables.get(entry.occurrenceId);
    if (!schedulable) continue;

    diagnostics.push({
      code: 'backlogged',
      severity: 'info',
      occurrenceId: entry.occurrenceId,
      taskId: schedulable.taskId,
      reason: entry.reason,
      ...(entry.estimatedWeek === null ? {} : { estimatedWeek: entry.estimatedWeek }),
      message: backlogMessage(schedulable, entry),
    });

    // A backlogged task with a due date is at risk by definition: it has no
    // place in the horizon at all, let alone one before the deadline.
    if (schedulable.dueDate !== undefined) {
      const hard = schedulable.dueKind === 'hard';
      diagnostics.push({
        code: hard ? 'hard_due_date_at_risk' : 'soft_due_date_at_risk',
        severity: hard ? 'alert' : 'warning',
        occurrenceId: entry.occurrenceId,
        taskId: schedulable.taskId,
        dueDate: schedulable.dueDate,
        reason: entry.reason,
        message: `Task ${schedulable.taskId} could not be placed in the horizon and has a ${hard ? 'hard' : 'soft'} due date at ${schedulable.dueDate}.`,
      });
    }
  }

  return sorted(
    diagnostics,
    chain(
      byId((d: Diagnostic) => d.occurrenceId),
      byId((d: Diagnostic) => d.code),
    ),
  );
}

function backlogMessage(schedulable: Schedulable, entry: BacklogEntry): string {
  const where =
    entry.estimatedWeek === null
      ? 'moved to the backlog with no week available in the planning window'
      : `moved to the backlog, estimated week ${entry.estimatedWeek}`;

  switch (entry.reason) {
    case 'no_feasible_window':
      return `Task ${schedulable.taskId} was ${where}: category ${schedulable.categoryId} has no availability window in this horizon.`;
    case 'hard_due_date_unreachable':
      return `Task ${schedulable.taskId} was ${where}: its hard due date falls before any window it could use.`;
    case 'manual_floor_beyond_horizon':
      return `Task ${schedulable.taskId} was ${where}: it was manually moved past the end of the horizon.`;
    default:
      return `Task ${schedulable.taskId} was ${where}: no window in its category has enough remaining free time.`;
  }
}
