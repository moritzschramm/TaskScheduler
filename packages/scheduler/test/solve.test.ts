import { describe, expect, it } from 'vitest';
import {
  solve,
  validateSchedule,
  withTuning,
  type Schedulable,
  type SolveResult,
} from '../src/index.js';
import { at, context, fixedBlock, MONDAY_WINDOW, schedulable } from './support/fixtures.js';

/**
 * Placement behaviour (spec §6.5, §6.1, §6.7).
 *
 * The single most important property is asserted throughout and again in the
 * property suite: whatever the solver returns must pass the M3 validator. A
 * task the solver cannot place legally goes to the backlog — it is never placed
 * illegally.
 */

const placementOf = (result: SolveResult, occurrenceId: string) =>
  result.placements.find((p) => p.occurrenceId === occurrenceId);

const backlogOf = (result: SolveResult, occurrenceId: string) =>
  result.backlog.find((b) => b.occurrenceId === occurrenceId);

describe('greedy placement', () => {
  it('places a single task flush against the start of its window', () => {
    // Earliness pulls forward and fragmentation rewards a zero leading gap, so
    // with no other preference the window edge is the expected answer.
    const task = schedulable({ occurrenceId: 'a', durationMin: 60 });
    const ctx = context({ schedulables: [task] });

    const result = solve(ctx);

    expect(placementOf(result, 'a')?.interval).toEqual({
      start: MONDAY_WINDOW.interval.start,
      end: MONDAY_WINDOW.interval.start + 60,
    });
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('packs several tasks back to back', () => {
    const tasks = ['a', 'b', 'c'].map((id) => schedulable({ occurrenceId: id, durationMin: 60 }));
    const ctx = context({ schedulables: tasks });

    const result = solve(ctx);

    const starts = result.placements.map((p) => p.interval.start);
    expect(starts).toEqual([
      MONDAY_WINDOW.interval.start,
      MONDAY_WINDOW.interval.start + 60,
      MONDAY_WINDOW.interval.start + 120,
    ]);
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('reserves the cooldown between consecutive tasks', () => {
    // Spec §6.2 rule 3: non-compressible, and part of the footprint for overlap.
    const tasks = ['a', 'b'].map((id) =>
      schedulable({ occurrenceId: id, durationMin: 60, cooldownMin: 30 }),
    );
    const ctx = context({ schedulables: tasks });

    const result = solve(ctx);

    const [first, second] = result.placements;
    expect(second!.interval.start).toBe(first!.interval.end + 30);
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('schedules around a fixed block', () => {
    const task = schedulable({ occurrenceId: 'a', durationMin: 120 });
    const ctx = context({
      schedulables: [task],
      fixedBlocks: [fixedBlock('dentist', '2026-03-23T08:00:00Z', '2026-03-23T09:00:00Z')],
    });

    const result = solve(ctx);

    expect(placementOf(result, 'a')?.interval.start).toBe(at('2026-03-23T09:00:00Z'));
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('schedules past a fixed block’s cooldown, not merely past the block', () => {
    // §6.2 rule 3, from the block's side: a meeting you need twenty minutes to
    // come back from occupies more of the afternoon than the meeting does.
    const task = schedulable({ occurrenceId: 'a', durationMin: 60 });
    const ctx = context({
      schedulables: [task],
      fixedBlocks: [fixedBlock('dentist', '2026-03-23T08:00:00Z', '2026-03-23T09:00:00Z', 20)],
    });

    const result = solve(ctx);

    expect(placementOf(result, 'a')?.interval.start).toBe(at('2026-03-23T09:20:00Z'));
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('never places a task before its manual floor', () => {
    // Spec §7.3: delayed, not fixed — later is fine, earlier is not.
    const task = schedulable({
      occurrenceId: 'a',
      durationMin: 60,
      manualFloor: at('2026-03-23T11:00:00Z'),
    });
    const ctx = context({ schedulables: [task] });

    const result = solve(ctx);

    expect(placementOf(result, 'a')?.interval.start).toBe(at('2026-03-23T11:00:00Z'));
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('honours a hard due date by placing earlier', () => {
    const task = schedulable({
      occurrenceId: 'a',
      durationMin: 60,
      dueDate: at('2026-03-23T10:00:00Z'),
      dueKind: 'hard',
    });
    const ctx = context({ schedulables: [task] });

    const result = solve(ctx);

    expect(placementOf(result, 'a')!.interval.end).toBeLessThanOrEqual(at('2026-03-23T10:00:00Z'));
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('keeps a task inside the window rather than overrunning it', () => {
    // The Monday window is eight hours; a nine-hour task cannot fit anywhere.
    const task = schedulable({ occurrenceId: 'a', durationMin: 9 * 60 });
    const ctx = context({ schedulables: [task] });

    const result = solve(ctx);

    expect(result.placements).toEqual([]);
    expect(backlogOf(result, 'a')?.reason).toBe('insufficient_remaining_capacity');
  });

  it('lets a cooldown run past the window edge', () => {
    // Rule 3 reserves the cooldown against other tasks, not against the clock.
    const task = schedulable({ occurrenceId: 'a', durationMin: 60, cooldownMin: 120 });
    const ctx = context({ schedulables: [task] });

    const result = solve(ctx);

    expect(placementOf(result, 'a')).toBeDefined();
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });
});

describe('placement order (spec §6.5 stage 1)', () => {
  it('gives the earliest slot to the more urgent task', () => {
    // Urgency dominates the stage-1 weights, so the near-due task chooses first
    // even though the other sorts earlier by id.
    const relaxed = schedulable({
      occurrenceId: 'a-relaxed',
      durationMin: 60,
      dueDate: at('2026-03-27T16:00:00Z'),
      dueKind: 'soft',
    });
    const urgent = schedulable({
      occurrenceId: 'z-urgent',
      durationMin: 60,
      dueDate: at('2026-03-23T12:00:00Z'),
      dueKind: 'soft',
    });

    const result = solve(context({ schedulables: [relaxed, urgent] }));

    expect(placementOf(result, 'z-urgent')!.interval.start).toBeLessThan(
      placementOf(result, 'a-relaxed')!.interval.start,
    );
  });

  it('prefers the higher-priority task when urgency is equal', () => {
    const low = schedulable({ occurrenceId: 'a-low', durationMin: 60, priority: 1 });
    const high = schedulable({ occurrenceId: 'z-high', durationMin: 60, priority: 5 });

    const result = solve(context({ schedulables: [low, high] }));

    expect(placementOf(result, 'z-high')!.interval.start).toBeLessThan(
      placementOf(result, 'a-low')!.interval.start,
    );
  });

  it('breaks a complete tie by occurrence id', () => {
    // Spec §6.3: every tie ends in an entity id, so the result is total.
    const first = schedulable({ occurrenceId: 'aaa', durationMin: 60 });
    const second = schedulable({ occurrenceId: 'bbb', durationMin: 60 });

    const result = solve(context({ schedulables: [second, first] }));

    expect(placementOf(result, 'aaa')!.interval.start).toBeLessThan(
      placementOf(result, 'bbb')!.interval.start,
    );
  });
});

describe('slot preference (spec §6.5 stage 2)', () => {
  it('moves a task into its preferred time range', () => {
    // 13:00–15:00 Berlin is 12:00–14:00Z on this date.
    const task = schedulable({
      occurrenceId: 'a',
      durationMin: 60,
      preferredRange: { startMin: 13 * 60, endMin: 15 * 60 },
    });

    const result = solve(context({ schedulables: [task] }));

    expect(placementOf(result, 'a')?.interval.start).toBe(at('2026-03-23T12:00:00Z'));
  });

  it('prefers a window whose focus profile matches the task', () => {
    const deepWindow = {
      ...MONDAY_WINDOW,
      ruleId: 'rule-deep',
      focusLevel: 5,
      interval: { start: at('2026-03-23T13:00:00Z'), end: at('2026-03-23T16:00:00Z') },
    };
    const shallowWindow = {
      ...MONDAY_WINDOW,
      ruleId: 'rule-shallow',
      focusLevel: 1,
      interval: { start: at('2026-03-23T08:00:00Z'), end: at('2026-03-23T11:00:00Z') },
    };
    const task = schedulable({ occurrenceId: 'a', durationMin: 60, focusLevel: 5 });

    const result = solve(context({ schedulables: [task], windows: [shallowWindow, deepWindow] }));

    // Earliness favours the shallow morning window; the focus match outweighs it.
    expect(placementOf(result, 'a')?.interval.start).toBe(at('2026-03-23T13:00:00Z'));
  });

  it('pulls a repositioned task to where it was dropped, not to the earliest slot', () => {
    // §7.3: `MoveTask` sets a floor *and* a bias. The floor alone would leave
    // this at 11:00 either way; what is under test is the bias, which is the
    // half that has to work when something else wants the same time.
    const moved = schedulable({
      occurrenceId: 'moved',
      durationMin: 60,
      manualFloor: at('2026-03-23T11:00:00Z'),
      manualBias: at('2026-03-23T14:00:00Z'),
    });

    const result = solve(context({ schedulables: [moved] }));

    expect(placementOf(result, 'moved')?.interval.start).toBe(at('2026-03-23T14:00:00Z'));
  });

  it('lets a bias lose to a hard constraint, because a bias is not a pin', () => {
    // An appointment sits exactly where the user dropped the task. §7.3: the
    // task is delayed, not fixed — it moves, and the floor decides which way.
    // Floor and bias coincide, as `MoveTask` sets them, so the only direction
    // left is later.
    const moved = schedulable({
      occurrenceId: 'moved',
      durationMin: 60,
      manualFloor: at('2026-03-23T14:00:00Z'),
      manualBias: at('2026-03-23T14:00:00Z'),
    });
    const blocked = solve(
      context({
        schedulables: [moved],
        fixedBlocks: [fixedBlock('appt', '2026-03-23T14:00:00Z', '2026-03-23T15:00:00Z')],
      }),
    );

    expect(placementOf(blocked, 'moved')?.interval.start).toBe(at('2026-03-23T15:00:00Z'));
  });
});

describe('backlog and infeasibility (spec §6.1, §6.7)', () => {
  it('pushes over-capacity tasks to the backlog rather than overlapping them', () => {
    // Sixteen hours of window against twenty hours of work.
    const tasks: Schedulable[] = Array.from({ length: 20 }, (_, i) =>
      schedulable({ occurrenceId: `occ-${String(i).padStart(2, '0')}`, durationMin: 60 }),
    );
    const ctx = context({ schedulables: tasks });

    const result = solve(ctx);

    expect(result.placements).toHaveLength(16);
    expect(result.backlog).toHaveLength(4);
    // The invariant that matters: over-capacity degrades to backlog, never to
    // an invalid schedule.
    expect(validateSchedule(ctx, result.placements).valid).toBe(true);
  });

  it('reports an activity type with no windows as a configuration problem', () => {
    const task = schedulable({ occurrenceId: 'a', activityTypeId: 'cat-exercise' });

    const result = solve(context({ schedulables: [task] }));

    const entry = backlogOf(result, 'a');
    expect(entry?.reason).toBe('no_feasible_window');
    // No windows means no honest weekly estimate to give.
    expect(entry?.estimatedWeek).toBeNull();
  });

  it('reports an unreachable hard due date distinctly from a full calendar', () => {
    const task = schedulable({
      occurrenceId: 'a',
      durationMin: 60,
      dueDate: at('2026-03-23T07:00:00Z'),
      dueKind: 'hard',
    });

    const result = solve(context({ schedulables: [task] }));

    expect(backlogOf(result, 'a')?.reason).toBe('hard_due_date_unreachable');
  });

  it('reports a manual floor past the horizon distinctly', () => {
    const task = schedulable({
      occurrenceId: 'a',
      durationMin: 60,
      manualFloor: at('2026-04-15T09:00:00Z'),
    });

    const result = solve(context({ schedulables: [task] }));

    expect(backlogOf(result, 'a')?.reason).toBe('manual_floor_beyond_horizon');
  });

  it('assigns backlog weeks in due-date order', () => {
    // Each task is longer than any single window, so none can be placed and all
    // land in the backlog. Weekly supply is 960 minutes, so only one 500-minute
    // task fits per week and the ordering is forced to show.
    const late = schedulable({
      occurrenceId: 'aaa-late',
      durationMin: 500,
      dueDate: at('2026-05-01T12:00:00Z'),
      dueKind: 'soft',
    });
    const early = schedulable({
      occurrenceId: 'zzz-early',
      durationMin: 500,
      dueDate: at('2026-04-10T12:00:00Z'),
      dueKind: 'soft',
    });

    const result = solve(context({ schedulables: [late, early] }));

    expect(result.placements).toEqual([]);
    // The nearer deadline takes the earlier week despite sorting later by id.
    expect(backlogOf(result, 'zzz-early')?.estimatedWeek).toBe('2026-03-30');
    expect(backlogOf(result, 'aaa-late')?.estimatedWeek).toBe('2026-04-06');
  });

  it('formats the estimated week as the week-start date', () => {
    const task = schedulable({ occurrenceId: 'a', durationMin: 9 * 60 });

    const result = solve(context({ schedulables: [task] }));

    // Horizon ends Monday 2026-03-30, so the first planning week starts there.
    expect(backlogOf(result, 'a')?.estimatedWeek).toBe('2026-03-30');
  });
});

describe('diagnostics (spec §6.5 post-placement pass, §11)', () => {
  it('warns on a soft due date and alerts on a hard one', () => {
    const soft = schedulable({
      occurrenceId: 'soft',
      durationMin: 9 * 60,
      dueDate: at('2026-03-24T12:00:00Z'),
      dueKind: 'soft',
    });
    const hard = schedulable({
      occurrenceId: 'hard',
      durationMin: 9 * 60,
      dueDate: at('2026-03-24T12:00:00Z'),
      dueKind: 'hard',
    });

    const result = solve(context({ schedulables: [soft, hard] }));

    const softDiag = result.diagnostics.find(
      (d) => d.occurrenceId === 'soft' && d.code !== 'backlogged',
    );
    const hardDiag = result.diagnostics.find(
      (d) => d.occurrenceId === 'hard' && d.code !== 'backlogged',
    );

    expect(softDiag?.severity).toBe('warning');
    expect(hardDiag?.severity).toBe('alert');
  });

  it('reports a backlogged task informationally with its reason', () => {
    const task = schedulable({ occurrenceId: 'a', activityTypeId: 'cat-exercise' });

    const result = solve(context({ schedulables: [task] }));

    const diagnostic = result.diagnostics.find((d) => d.code === 'backlogged');
    expect(diagnostic?.severity).toBe('info');
    expect(diagnostic?.reason).toBe('no_feasible_window');
    expect(diagnostic?.message).toContain('no availability window');
  });

  it('says nothing when every task fits comfortably', () => {
    const task = schedulable({ occurrenceId: 'a', durationMin: 60 });

    const result = solve(context({ schedulables: [task] }));

    expect(result.diagnostics).toEqual([]);
  });
});

describe('horizon (spec §6.1)', () => {
  it('derives the current-plus-next week when the caller gives no horizon', () => {
    const task = schedulable({ occurrenceId: 'a', durationMin: 60 });
    const result = solve(
      context({
        schedulables: [task],
        // An empty horizon asks the solver to derive one from `now`.
        horizon: { start: 0, end: 0 },
      }),
    );

    // Monday 2026-03-23 through Monday 2026-04-06, in Berlin local time.
    expect(result.horizon.start).toBe(at('2026-03-22T23:00:00Z'));
    expect(result.horizon.end).toBe(at('2026-04-05T22:00:00Z'));
  });

  it('respects a configured horizon length', () => {
    const result = solve(context({ schedulables: [], horizon: { start: 0, end: 0 } }), {
      config: withTuning({ hardHorizonWeeks: 1 }),
    });

    // 2026-03-29T22:00Z, not 23:00Z: the week ends after the spring DST switch,
    // so local midnight on the 30th is an hour earlier in UTC. The week that
    // contains a transition is 167 hours long, and the horizon reflects that.
    expect(result.horizon.end).toBe(at('2026-03-29T22:00:00Z'));
  });
});
