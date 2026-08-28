import { describe, expect, it } from 'vitest';
import {
  buildPlacementUnits,
  expandUnit,
  solve,
  validateSchedule,
  type Placement,
  type Schedulable,
} from '../src/index.js';
import { at, context, MONDAY_WINDOW, schedulable, sequence } from './support/fixtures.js';

/**
 * Uninterruptible sequences (spec §6.2 rule 5, §6.4).
 *
 * Two halves. The first is the collapse: a sequence becomes one composite whose
 * span is the members plus the cooldowns between them, and whose hard
 * constraints are every member's constraint re-expressed as a bound on where
 * the block may start. The second is that the solver places that composite as
 * an indivisible thing, so contiguity, ordering, single-window containment and
 * non-interleaving all hold by construction rather than by a later check.
 */

const MONDAY = MONDAY_WINDOW.interval.start;

function member(id: string, overrides: Partial<Schedulable> = {}): Schedulable {
  return schedulable({ occurrenceId: id, sequenceId: 'seq-1', ...overrides });
}

function unitFor(schedulables: Schedulable[], isOrdered = false) {
  const units = buildPlacementUnits(
    context({ schedulables, sequences: [sequence('seq-1', isOrdered)] }),
  );
  const unit = units.find((candidate) => candidate.sequenceId === 'seq-1');
  expect(unit).toBeDefined();
  return unit!;
}

function placementOf(placements: readonly Placement[], id: string): Placement | undefined {
  return placements.find((placement) => placement.occurrenceId === id);
}

describe('collapsing a sequence to a composite (spec §6.4)', () => {
  it('sums the member durations and the cooldowns between them', () => {
    const unit = unitFor(
      [
        member('a', { durationMin: 60, cooldownMin: 0, sequencePosition: 1 }),
        member('b', { durationMin: 30, cooldownMin: 15, sequencePosition: 2 }),
        member('c', { durationMin: 45, cooldownMin: 30, sequencePosition: 3 }),
      ],
      true,
    );

    // 60 + (0) + 30 + (15) + 45 = 150. The final member's 30-minute cooldown
    // trails the block rather than sitting inside it.
    expect(unit.composite.durationMin).toBe(150);
    expect(unit.composite.cooldownMin).toBe(30);
    expect(unit.members.map((entry) => entry.startOffset)).toEqual([0, 60, 105]);
  });

  it('leaves a lone task as a unit of one', () => {
    const units = buildPlacementUnits(
      context({ schedulables: [schedulable({ durationMin: 45 })] }),
    );

    expect(units).toHaveLength(1);
    expect(units[0]!.sequenceId).toBeUndefined();
    expect(units[0]!.composite.durationMin).toBe(45);
    expect(units[0]!.members).toHaveLength(1);
  });

  it('orders members by sequence position when the sequence is ordered', () => {
    const unit = unitFor(
      [
        member('zzz', { sequencePosition: 1 }),
        member('aaa', { sequencePosition: 2 }),
        member('mmm', { sequencePosition: 3 }),
      ],
      true,
    );

    // Position wins over the id, which would otherwise sort aaa first.
    expect(unit.members.map((entry) => entry.schedulable.occurrenceId)).toEqual([
      'zzz',
      'aaa',
      'mmm',
    ]);
  });

  it('puts the longest cooldown last when the sequence is unordered', () => {
    // Only the cooldowns *between* members lengthen the span that has to fit a
    // window, so the block is shortest when the biggest cooldown trails it.
    const unit = unitFor([
      member('a', { durationMin: 60, cooldownMin: 45 }),
      member('b', { durationMin: 60, cooldownMin: 0 }),
      member('c', { durationMin: 60, cooldownMin: 15 }),
    ]);

    expect(unit.members.map((entry) => entry.schedulable.occurrenceId)).toEqual(['b', 'c', 'a']);
    // 60 + 0 + 60 + 15 + 60 = 195, rather than the 240 the reverse order costs.
    expect(unit.composite.durationMin).toBe(195);
    expect(unit.composite.cooldownMin).toBe(45);
  });

  it('turns a member due date into a bound on the block start', () => {
    // The second member ends 60 minutes into the block, so a deadline on it is
    // a deadline on the block start plus 60.
    const unit = unitFor(
      [
        member('a', { durationMin: 60, cooldownMin: 0, sequencePosition: 1 }),
        member('b', {
          durationMin: 60,
          cooldownMin: 0,
          sequencePosition: 2,
          dueDate: MONDAY + 180,
          dueKind: 'hard',
        }),
      ],
      true,
    );

    expect(unit.composite.dueKind).toBe('hard');
    // Latest block start is 180 − 120 = 60; expressed as a composite deadline
    // that is 60 + the 120-minute span.
    expect(unit.composite.dueDate).toBe(MONDAY + 180);
  });

  it('takes the tightest member bound, not the first', () => {
    const unit = unitFor(
      [
        member('a', {
          durationMin: 60,
          cooldownMin: 0,
          sequencePosition: 1,
          dueDate: MONDAY + 600,
          dueKind: 'hard',
        }),
        member('b', {
          durationMin: 60,
          cooldownMin: 0,
          sequencePosition: 2,
          dueDate: MONDAY + 180,
          dueKind: 'hard',
        }),
      ],
      true,
    );

    // Member a allows a start up to 540, member b only up to 60. The tighter wins.
    expect(unit.composite.dueDate).toBe(MONDAY + 180);
  });

  it('lets a hard member bound override a soft one', () => {
    const unit = unitFor(
      [
        member('a', {
          durationMin: 60,
          sequencePosition: 1,
          dueDate: MONDAY + 90,
          dueKind: 'soft',
        }),
        member('b', {
          durationMin: 60,
          sequencePosition: 2,
          dueDate: MONDAY + 600,
          dueKind: 'hard',
        }),
      ],
      true,
    );

    // Only the hard bound is enforceable; the soft one is scored and may slip.
    expect(unit.composite.dueKind).toBe('hard');
    expect(unit.composite.dueDate).toBe(MONDAY + 600);
  });

  it('turns a member manual floor into a bound on the block start', () => {
    const unit = unitFor(
      [
        member('a', { durationMin: 60, sequencePosition: 1 }),
        member('b', { durationMin: 60, sequencePosition: 2, manualFloor: MONDAY + 300 }),
      ],
      true,
    );

    // b sits 60 minutes into the block, so the block may not start before 240.
    expect(unit.composite.manualFloor).toBe(MONDAY + 240);
  });

  it('takes the highest priority and the deepest focus of its members', () => {
    const unit = unitFor([
      member('a', { priority: 2, focusLevel: 1 }),
      member('b', { priority: 5, focusLevel: 4 }),
    ]);

    expect(unit.composite.priority).toBe(5);
    expect(unit.composite.focusLevel).toBe(4);
  });

  it('refuses a sequence whose members are in different categories', () => {
    // No window belongs to two categories, so no window can hold this block.
    // Placing it anyway would put a member outside its own availability.
    const unit = unitFor([member('a'), member('b', { categoryId: 'cat-other' })]);

    expect(unit.blocked).toBe('sequence_members_incompatible');
  });

  it('groups members of an undeclared sequence rather than dropping the constraint', () => {
    const units = buildPlacementUnits(
      context({ schedulables: [member('a'), member('b')], sequences: [] }),
    );

    expect(units).toHaveLength(1);
    expect(units[0]!.sequenceId).toBe('seq-1');
  });

  it('expands a placed block back onto its members', () => {
    const unit = unitFor(
      [
        member('a', { durationMin: 60, cooldownMin: 15, sequencePosition: 1 }),
        member('b', { durationMin: 30, cooldownMin: 0, sequencePosition: 2 }),
      ],
      true,
    );

    expect(expandUnit(unit, MONDAY)).toEqual([
      { occurrenceId: 'a', interval: { start: MONDAY, end: MONDAY + 60 }, cooldownMin: 15 },
      { occurrenceId: 'b', interval: { start: MONDAY + 75, end: MONDAY + 105 }, cooldownMin: 0 },
    ]);
  });
});

describe('placing a sequence (spec §6.2 rule 5)', () => {
  it('places members back to back, with the internal cooldowns between them', () => {
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 60, cooldownMin: 15, sequencePosition: 1 }),
        member('b', { durationMin: 30, cooldownMin: 0, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const result = solve(ctx);

    const a = placementOf(result.placements, 'a')!;
    const b = placementOf(result.placements, 'b')!;
    expect(b.interval.start).toBe(a.interval.end + a.cooldownMin);
    expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
  });

  it('places ordered members in position order', () => {
    const ctx = context({
      schedulables: [
        member('zzz', { sequencePosition: 1 }),
        member('aaa', { sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const result = solve(ctx);

    expect(placementOf(result.placements, 'zzz')!.interval.start).toBeLessThan(
      placementOf(result.placements, 'aaa')!.interval.start,
    );
  });

  it('never wedges a foreign task inside the block', () => {
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 60, cooldownMin: 30, sequencePosition: 1 }),
        member('b', { durationMin: 60, cooldownMin: 0, sequencePosition: 2 }),
        schedulable({ occurrenceId: 'foreign', durationMin: 30 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const result = solve(ctx);

    expect(result.placements).toHaveLength(3);
    const first = placementOf(result.placements, 'a')!;
    const last = placementOf(result.placements, 'b')!;
    const foreign = placementOf(result.placements, 'foreign')!;

    // The whole span, trailing cooldown included, is off limits.
    const spanStart = first.interval.start;
    const spanEnd = last.interval.end + last.cooldownMin;
    expect(foreign.interval.start >= spanEnd || foreign.interval.end <= spanStart).toBe(true);
    expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
  });

  it('keeps the whole block inside a single window', () => {
    // 420 minutes fits the 480-minute Monday window but would have to straddle
    // the overnight gap if the engine were willing to split it.
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 240, sequencePosition: 1 }),
        member('b', { durationMin: 180, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const result = solve(ctx);

    expect(result.placements).toHaveLength(2);
    expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
  });

  it('honours a member due date that binds the middle of the block', () => {
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 60, sequencePosition: 1 }),
        member('b', {
          durationMin: 60,
          sequencePosition: 2,
          dueDate: MONDAY + 150,
          dueKind: 'hard',
        }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const result = solve(ctx);

    expect(placementOf(result.placements, 'b')!.interval.end).toBeLessThanOrEqual(MONDAY + 150);
    expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
  });

  it('backlogs every member together rather than placing part of a sequence', () => {
    // 600 minutes of block against a 480-minute window: nothing fits, and half
    // a sequence is not a partial success but a rule-5 violation.
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 300, sequencePosition: 1 }),
        member('b', { durationMin: 300, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const result = solve(ctx);

    expect(result.placements).toEqual([]);
    expect(result.backlog.map((entry) => entry.occurrenceId).sort()).toEqual(['a', 'b']);
    for (const entry of result.backlog) {
      expect(entry.reason).toBe('no_contiguous_span');
      expect(entry.sequenceId).toBe('seq-1');
      // A window too short is a fact about the calendar, not about this
      // fortnight, so no future week can honestly be promised.
      expect(entry.estimatedWeek).toBeNull();
    }
  });

  it('names fragmentation, not capacity, when the minutes exist but not in a row', () => {
    // 480 free minutes chopped into 210 + 240 by an hour-long meeting. A
    // 300-minute block has capacity three times over and nowhere to go — the
    // exact case §6.6 says a totals-only check would miss.
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 150, sequencePosition: 1 }),
        member('b', { durationMin: 150, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
      fixedBlocks: [
        {
          id: 'meeting',
          calendarId: 'cal-1',
          interval: { start: MONDAY + 210, end: MONDAY + 240 },
        },
      ],
      windows: [MONDAY_WINDOW],
    });

    const result = solve(ctx);

    expect(result.placements).toEqual([]);
    expect(result.backlog[0]?.reason).toBe('no_contiguous_span');
  });

  it('backlogs a sequence whose members are in different categories', () => {
    const ctx = context({
      schedulables: [member('a'), member('b', { categoryId: 'cat-other' })],
      sequences: [sequence('seq-1')],
    });

    const result = solve(ctx);

    expect(result.placements).toEqual([]);
    expect(result.backlog).toHaveLength(2);
    expect(result.backlog[0]?.reason).toBe('sequence_members_incompatible');
  });

  it('reports each member with its own diagnostic, tagged with the sequence', () => {
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 300, sequencePosition: 1 }),
        member('b', { durationMin: 300, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const diagnostics = solve(ctx).diagnostics.filter((entry) => entry.code === 'backlogged');

    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.sequenceId).toBe('seq-1');
      expect(diagnostic.message).toContain('one piece');
    }
  });

  it('places a sequence ahead of a lower-scoring lone task', () => {
    // Stage 1 scores the composite, so a whole block competes for the calendar
    // as one thing rather than member by member.
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 120, priority: 5, sequencePosition: 1 }),
        member('b', { durationMin: 120, priority: 5, sequencePosition: 2 }),
        schedulable({ occurrenceId: 'lone', durationMin: 120, priority: 1 }),
      ],
      sequences: [sequence('seq-1', true)],
      windows: [MONDAY_WINDOW],
    });

    const result = solve(ctx);

    expect(placementOf(result.placements, 'a')!.interval.start).toBe(MONDAY);
    expect(placementOf(result.placements, 'lone')!.interval.start).toBe(MONDAY + 240);
  });
});

describe('the validator agrees with the solver about sequences', () => {
  it('rejects a schedule the solver would never produce', () => {
    // A gap of a single minute between two members is still a broken block.
    const ctx = context({
      schedulables: [
        member('a', { durationMin: 60, cooldownMin: 0, sequencePosition: 1 }),
        member('b', { durationMin: 60, cooldownMin: 0, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const tampered: Placement[] = [
      { occurrenceId: 'a', interval: { start: MONDAY, end: MONDAY + 60 }, cooldownMin: 0 },
      { occurrenceId: 'b', interval: { start: MONDAY + 61, end: MONDAY + 121 }, cooldownMin: 0 },
    ];

    const result = validateSchedule(ctx, tampered);

    expect(result.violations.map((violation) => violation.code)).toContain(
      'sequence_not_contiguous',
    );
  });

  it('accepts a block held by one of two overlapping windows', () => {
    // Nothing in the schema stops a category having two overlapping
    // availability windows. Resolving each member to "the first window that
    // contains it" would split this block between the short window and the long
    // one, even though the long one comfortably holds the whole thing.
    const short = {
      ...MONDAY_WINDOW,
      ruleId: 'rule-short',
      interval: { start: MONDAY, end: MONDAY + 120 },
    };
    const ctx = context({
      windows: [short, MONDAY_WINDOW],
      schedulables: [
        member('a', { durationMin: 60, sequencePosition: 1 }),
        member('b', { durationMin: 60, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const placements: Placement[] = [
      { occurrenceId: 'a', interval: { start: MONDAY + 60, end: MONDAY + 120 }, cooldownMin: 0 },
      { occurrenceId: 'b', interval: { start: MONDAY + 120, end: MONDAY + 180 }, cooldownMin: 0 },
    ];

    // Member a fits the short window, member b does not; the eight-hour window
    // holds both, which is all rule 5 asks for.
    expect(validateSchedule(ctx, placements).violations).toEqual([]);
  });

  it('holds an undeclared sequence to rule 5 as well', () => {
    const ctx = context({
      schedulables: [member('a', { durationMin: 60 }), member('b', { durationMin: 60 })],
      sequences: [],
    });

    const tampered: Placement[] = [
      { occurrenceId: 'a', interval: { start: MONDAY, end: MONDAY + 60 }, cooldownMin: 0 },
      { occurrenceId: 'b', interval: { start: MONDAY + 240, end: MONDAY + 300 }, cooldownMin: 0 },
    ];

    expect(validateSchedule(ctx, tampered).valid).toBe(false);
  });
});

describe('sequences under a horizon boundary', () => {
  it('does not split a block across the horizon end', () => {
    const ctx = context({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-03-23T12:00:00Z') },
      schedulables: [
        member('a', { durationMin: 180, sequencePosition: 1 }),
        member('b', { durationMin: 180, sequencePosition: 2 }),
      ],
      sequences: [sequence('seq-1', true)],
    });

    const result = solve(ctx);

    for (const placement of result.placements) {
      expect(placement.interval.end).toBeLessThanOrEqual(result.horizon.end);
    }
    expect(validateSchedule(ctx, result.placements).violations).toEqual([]);
  });
});
