import { describe, expect, it } from 'vitest';
import { assessDeferral, assessDeferrals, withTuning, type DeferralHistory } from '../src/index.js';
import { at } from './support/fixtures.js';

/**
 * Chronic postponement (spec §6.6).
 *
 * The signal exists to say something capacity cannot: not "this week is too
 * full" but "this particular thing keeps being pushed". The separation the spec
 * insists on — user-initiated deferrals versus involuntary reflows — is the
 * load-bearing part, and the test that matters most is the one asserting a task
 * moved a hundred times by a bulk action never trips it.
 */

function history(overrides: Partial<DeferralHistory> = {}): DeferralHistory {
  return { taskId: 'task-1', deferCount: 0, ...overrides };
}

describe('the chronic-postponement threshold (spec §6.6, §15)', () => {
  it('stays quiet below the threshold', () => {
    expect(assessDeferral(history({ deferCount: 2 }))).toBeUndefined();
  });

  it('fires at the threshold, not one past it', () => {
    // §6.6 says "deferred ≥ N times".
    const signal = assessDeferral(history({ deferCount: 3 }));

    expect(signal?.code).toBe('chronic_postponement');
    expect(signal?.severity).toBe('warning');
    expect(signal?.triggers).toEqual(['defer_count']);
    expect(signal?.threshold).toBe(3);
  });

  it('takes the threshold from configuration', () => {
    const config = withTuning({ chronicPostponementThreshold: 5 });

    expect(assessDeferral(history({ deferCount: 4 }), config)).toBeUndefined();
    expect(assessDeferral(history({ deferCount: 5 }), config)).toBeDefined();
  });

  it('never fires on a non-positive threshold', () => {
    // A threshold of zero would flag every task ever created, which is
    // indistinguishable from the feature being broken.
    const config = withTuning({ chronicPostponementThreshold: 0 });

    expect(assessDeferral(history({ deferCount: 99 }), config)).toBeUndefined();
  });
});

describe('user deferrals and involuntary reflows are distinct (spec §6.6)', () => {
  it('does not fire on reflows however many there are', () => {
    // A task moved twenty times by the sick-day bulk action has not been
    // avoided by anyone. Counting these would flag exactly the tasks the user
    // is least responsible for.
    const signal = assessDeferral(history({ deferCount: 0, reflowCount: 20 }));

    expect(signal).toBeUndefined();
  });

  it('reports the reflow count alongside a signal it did not cause', () => {
    const signal = assessDeferral(history({ deferCount: 3, reflowCount: 7 }));

    expect(signal?.triggers).toEqual(['defer_count']);
    expect(signal?.deferCount).toBe(3);
    expect(signal?.reflowCount).toBe(7);
  });
});

describe('estimated-week slippage (spec §6.6)', () => {
  it('fires on repeated slippage even with no user deferral', () => {
    const signal = assessDeferral(history({ deferCount: 0, estimatedWeekMisses: 3 }));

    expect(signal?.triggers).toEqual(['estimated_week_slippage']);
    expect(signal?.message).toContain('slipped its estimated week 3 times');
  });

  it('reports both triggers when both conditions hold', () => {
    const signal = assessDeferral(history({ deferCount: 4, estimatedWeekMisses: 3 }));

    expect(signal?.triggers).toEqual(['defer_count', 'estimated_week_slippage']);
  });

  it('does not add the two counts together to reach the threshold', () => {
    // Two of each is not "four deferrals": they are different events and the
    // spec's condition is "or", not a sum.
    expect(assessDeferral(history({ deferCount: 2, estimatedWeekMisses: 2 }))).toBeUndefined();
  });
});

describe('the signal a user sees', () => {
  it('carries the last reason and time through', () => {
    const signal = assessDeferral(
      history({
        deferCount: 3,
        lastDeferReason: 'no energy',
        lastDeferAt: at('2026-03-20T09:00:00Z'),
      }),
    );

    expect(signal?.lastDeferReason).toBe('no energy');
    expect(signal?.lastDeferAt).toBe(at('2026-03-20T09:00:00Z'));
    expect(signal?.message).toContain('Last reason: no energy.');
  });

  it('names the task and the count', () => {
    const signal = assessDeferral(history({ taskId: 'task-taxes', deferCount: 6 }));

    expect(signal?.message).toBe('Task task-taxes keeps getting pushed: postponed 6 times.');
  });

  it('carries an occurrence id when the history is tracked per occurrence', () => {
    const signal = assessDeferral(history({ deferCount: 3, occurrenceId: 'occ-1' }));

    expect(signal?.occurrenceId).toBe('occ-1');
  });

  it('omits the occurrence id when there is none, rather than emitting undefined', () => {
    expect(assessDeferral(history({ deferCount: 3 }))).not.toHaveProperty('occurrenceId');
  });
});

describe('assessing a batch', () => {
  it('returns only the chronic ones, worst first', () => {
    const signals = assessDeferrals([
      history({ taskId: 'mild', deferCount: 1 }),
      history({ taskId: 'bad', deferCount: 4 }),
      history({ taskId: 'worst', deferCount: 9 }),
      history({ taskId: 'slipping', deferCount: 0, estimatedWeekMisses: 5 }),
    ]);

    expect(signals.map((signal) => signal.taskId)).toEqual(['worst', 'bad', 'slipping']);
  });

  it('breaks ties by task id so the list never reorders itself', () => {
    const signals = assessDeferrals([
      history({ taskId: 'zzz', deferCount: 3 }),
      history({ taskId: 'aaa', deferCount: 3 }),
    ]);

    expect(signals.map((signal) => signal.taskId)).toEqual(['aaa', 'zzz']);
  });

  it('is a pure function of its input', () => {
    const histories = [history({ taskId: 'a', deferCount: 5 })];
    const snapshot = JSON.stringify(histories);

    expect(assessDeferrals(histories)).toEqual(assessDeferrals(histories));
    expect(JSON.stringify(histories)).toBe(snapshot);
  });

  it('returns nothing for an empty list', () => {
    expect(assessDeferrals([])).toEqual([]);
  });
});
