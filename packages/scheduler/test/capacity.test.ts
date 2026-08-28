import { describe, expect, it } from 'vitest';
import {
  computeCapacity,
  computeHardHorizon,
  DEFAULT_TUNING,
  freeSpans,
  maxSpanMinutes,
  mergeIntervals,
  solve,
  totalMinutes,
  withTuning,
  ONE,
  type CapacityCell,
  type CapacityReport,
} from '../src/index.js';
import {
  at,
  context,
  fixedBlock,
  MONDAY_WINDOW,
  schedulable,
  sequence,
  TUESDAY_WINDOW,
} from './support/fixtures.js';

/**
 * Capacity, utilization and the contiguity check (spec §6.6).
 *
 * The interesting half is the second one. A week can hold four times the
 * minutes a sequence needs and still have nowhere to put it, because the
 * minutes arrive in fragments; a report that only divided demand by supply
 * would call that week comfortable right up until the solver failed.
 */

const MONDAY = MONDAY_WINDOW.interval.start;
const WEEK = '2026-03-23';

/** Both fixture windows are eight hours. */
const WINDOW_MIN = 480;

function cellOf(report: CapacityReport, week = WEEK): CapacityCell | undefined {
  return report.cells.find((cell) => cell.weekStart === week && cell.categoryId === 'cat-work');
}

describe('interval algebra', () => {
  it('merges overlapping and touching intervals', () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 20, end: 30 },
        { start: 15, end: 18 },
        { start: 40, end: 50 },
      ]),
    ).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 50 },
    ]);
  });

  it('drops empty intervals rather than emitting zero-length spans', () => {
    expect(mergeIntervals([{ start: 10, end: 10 }])).toEqual([]);
  });

  it('carves occupied time out of the available time', () => {
    expect(freeSpans([{ start: 0, end: 100 }], [{ start: 30, end: 50 }])).toEqual([
      { start: 0, end: 30 },
      { start: 50, end: 100 },
    ]);
  });

  it('clips an occupied block that overruns the available interval', () => {
    expect(freeSpans([{ start: 0, end: 100 }], [{ start: 80, end: 200 }])).toEqual([
      { start: 0, end: 80 },
    ]);
  });

  it('never lets a free span cross from one interval into the next', () => {
    // Two windows that touch exactly. Rule 5 would not let a sequence cross the
    // seam, so neither may the span that says whether one fits.
    const spans = freeSpans(
      [
        { start: 0, end: 100 },
        { start: 100, end: 200 },
      ],
      [],
    );

    expect(spans).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
    ]);
    expect(maxSpanMinutes(spans)).toBe(100);
    expect(totalMinutes(spans)).toBe(200);
  });
});

describe('supply (spec §6.6)', () => {
  it('counts the window minutes of a category in a week', () => {
    const report = computeCapacity({ context: context({ windows: [MONDAY_WINDOW] }) });

    expect(cellOf(report)?.supplyMin).toBe(WINDOW_MIN);
  });

  it('subtracts the fixed blocks that fall inside the windows', () => {
    const report = computeCapacity({
      context: context({
        windows: [MONDAY_WINDOW],
        fixedBlocks: [fixedBlock('meeting', '2026-03-23T09:00:00Z', '2026-03-23T10:00:00Z')],
      }),
    });

    expect(cellOf(report)?.supplyMin).toBe(WINDOW_MIN - 60);
  });

  it('ignores a fixed block outside the windows', () => {
    // Time the user was never available for is not capacity being consumed.
    const report = computeCapacity({
      context: context({
        windows: [MONDAY_WINDOW],
        fixedBlocks: [fixedBlock('evening', '2026-03-23T19:00:00Z', '2026-03-23T20:00:00Z')],
      }),
    });

    expect(cellOf(report)?.supplyMin).toBe(WINDOW_MIN);
  });

  it('counts overlapping windows once', () => {
    const overlapping = {
      ...MONDAY_WINDOW,
      ruleId: 'rule-mon-b',
      interval: { start: MONDAY + 240, end: MONDAY + 720 },
    };

    const report = computeCapacity({
      context: context({ windows: [MONDAY_WINDOW, overlapping] }),
    });

    // 08:00–16:00 union 12:00–20:00 is twelve hours, not sixteen.
    expect(cellOf(report)?.supplyMin).toBe(720);
  });

  it('splits supply across the weeks the windows fall in', () => {
    const nextWeek = {
      ...MONDAY_WINDOW,
      ruleId: 'rule-mon-next',
      interval: { start: at('2026-03-30T08:00:00Z'), end: at('2026-03-30T16:00:00Z') },
    };

    const report = computeCapacity({
      context: context({
        horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-04-06T00:00:00Z') },
        windows: [MONDAY_WINDOW, nextWeek],
      }),
    });

    expect(cellOf(report, '2026-03-23')?.supplyMin).toBe(WINDOW_MIN);
    expect(cellOf(report, '2026-03-30')?.supplyMin).toBe(WINDOW_MIN);
  });
});

describe('utilization bands (spec §6.6)', () => {
  it('is comfortable well below the tight threshold', () => {
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 60 })],
    });
    const { placements } = solve(ctx);

    const cell = cellOf(computeCapacity({ context: ctx, placements }))!;

    expect(cell.demandMin).toBe(60);
    expect(cell.utilization).toBe(ONE / 8);
    expect(cell.status).toBe('comfortable');
  });

  it('is tight between 0.85 and 1.0 inclusive', () => {
    // 420 of 480 minutes is 0.875.
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 420 })],
    });
    const { placements } = solve(ctx);

    expect(cellOf(computeCapacity({ context: ctx, placements }))?.status).toBe('tight');
  });

  it('is tight at exactly 1.0, not overcommitted', () => {
    // The spec's bands are `> 1.0` and `0.85–1.0`, so the boundary is fragile
    // rather than broken: the week fits, with nothing to spare.
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: WINDOW_MIN })],
    });
    const { placements } = solve(ctx);

    const cell = cellOf(computeCapacity({ context: ctx, placements }))!;
    expect(cell.utilization).toBe(ONE);
    expect(cell.status).toBe('tight');
  });

  it('is overcommitted above 1.0', () => {
    // Demand is attributed by due date when a task could not be placed, which
    // is how over-demand shows up at all (§6.6).
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [
        schedulable({ occurrenceId: 'a', durationMin: 400, dueDate: MONDAY + 600 }),
        schedulable({ occurrenceId: 'b', durationMin: 400, dueDate: MONDAY + 600 }),
      ],
    });
    const result = solve(ctx);

    const cell = cellOf(
      computeCapacity({ context: ctx, placements: result.placements, backlog: result.backlog }),
    )!;

    expect(cell.demandMin).toBe(800);
    expect(cell.utilization).toBeGreaterThan(ONE);
    expect(cell.status).toBe('overcommitted');
  });

  it('counts cooldown as demand and reports it separately', () => {
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 60, cooldownMin: 30 })],
    });
    const { placements } = solve(ctx);

    const cell = cellOf(computeCapacity({ context: ctx, placements }))!;

    // Once, on the demand side. The minutes §6.6 names are still available to a
    // caller that wants the literal formula.
    expect(cell.demandMin).toBe(90);
    expect(cell.reservedCooldownMin).toBe(30);
    expect(cell.supplyMin).toBe(WINDOW_MIN);
  });

  it('calls demand with no availability at all overcommitted', () => {
    const ctx = context({
      windows: [],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 60, dueDate: MONDAY + 120 })],
    });

    const cell = cellOf(computeCapacity({ context: ctx }))!;

    // A ratio to zero is not a number; the status still has to say something.
    expect(cell.supplyMin).toBe(0);
    expect(cell.utilization).toBeNull();
    expect(cell.status).toBe('overcommitted');
  });

  it('takes its thresholds from configuration', () => {
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 300 })],
    });
    const { placements } = solve(ctx);

    // 300/480 = 0.625: comfortable by default, tight once the band moves.
    expect(cellOf(computeCapacity({ context: ctx, placements }))?.status).toBe('comfortable');

    const config = withTuning({ capacityThresholds: { tight: ONE / 2, overcommitted: ONE } });
    expect(cellOf(computeCapacity({ context: ctx, placements, config }))?.status).toBe('tight');
  });
});

describe('demand attribution (spec §6.6)', () => {
  it('attributes a placed task to the week it sits in', () => {
    const ctx = context({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-04-06T00:00:00Z') },
      windows: [
        {
          ...MONDAY_WINDOW,
          ruleId: 'rule-next',
          interval: { start: at('2026-03-30T08:00:00Z'), end: at('2026-03-30T16:00:00Z') },
        },
      ],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 60 })],
    });
    const { placements } = solve(ctx);

    const report = computeCapacity({ context: ctx, placements });

    expect(cellOf(report, '2026-03-23')?.demandMin ?? 0).toBe(0);
    expect(cellOf(report, '2026-03-30')?.demandMin).toBe(60);
  });

  it('attributes an unplaced task to the week the planner estimated', () => {
    // A real two-week horizon, week-aligned in the calendar's own zone, because
    // the weeks capacity reports on are local ones.
    const horizon = computeHardHorizon(at('2026-03-23T06:00:00Z'), 'Europe/Berlin', DEFAULT_TUNING);
    const secondWeek = [
      {
        ...MONDAY_WINDOW,
        ruleId: 'rule-mon-2',
        interval: { start: at('2026-03-30T08:00:00Z'), end: at('2026-03-30T16:00:00Z') },
      },
      {
        ...TUESDAY_WINDOW,
        ruleId: 'rule-tue-2',
        interval: { start: at('2026-03-31T08:00:00Z'), end: at('2026-03-31T16:00:00Z') },
      },
    ];

    // 540 minutes fits none of the eight-hour windows, so it cannot be placed,
    // but it sits well inside the 960 minutes a typical week supplies.
    const ctx = context({
      horizon,
      windows: [MONDAY_WINDOW, TUESDAY_WINDOW, ...secondWeek],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 540 })],
    });
    const result = solve(ctx);

    expect(result.backlog[0]?.estimatedWeek).toBe('2026-04-06');

    const report = computeCapacity({
      context: ctx,
      placements: result.placements,
      backlog: result.backlog,
    });

    // The estimated week is beyond the horizon and deliberately not reported:
    // there is no window data out there to measure supply against.
    expect(report.cells.some((cell) => cell.weekStart === '2026-04-06')).toBe(false);
    // And with no due date it is not charged to the week it could not fit in.
    expect(cellOf(report)?.demandMin).toBe(0);
  });

  it('attributes a task with neither a placement nor a week by its due date', () => {
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 60, dueDate: MONDAY + 300 })],
    });

    expect(cellOf(computeCapacity({ context: ctx }))?.demandMin).toBe(60);
  });

  it('ignores a task with no placement, no estimate and no due date', () => {
    // Nothing ties it to a week, and guessing one would put demand where the
    // user never said it belonged.
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 60 })],
    });

    expect(cellOf(computeCapacity({ context: ctx }))?.demandMin).toBe(0);
  });
});

describe('the contiguity check (spec §6.6)', () => {
  it('reports the longest free run in a single window', () => {
    const report = computeCapacity({
      context: context({
        windows: [MONDAY_WINDOW],
        fixedBlocks: [fixedBlock('meeting', '2026-03-23T11:00:00Z', '2026-03-23T12:00:00Z')],
      }),
    });

    // 08:00–11:00 and 12:00–16:00: the longer run is four hours.
    expect(cellOf(report)?.maxContiguousSpanMin).toBe(240);
    expect(cellOf(report)?.supplyMin).toBe(WINDOW_MIN - 60);
  });

  it('never composes two windows into one longer run', () => {
    const report = computeCapacity({ context: context({ windows: [MONDAY_WINDOW] }) });

    expect(cellOf(report)?.supplyMin).toBe(WINDOW_MIN);
    expect(cellOf(report)?.maxContiguousSpanMin).toBe(WINDOW_MIN);
  });

  it('flags enough total minutes with no span long enough — §6.6 exactly', () => {
    // 420 free minutes in a week, chopped into 210 and 240 by a half-hour
    // meeting. A 300-minute block has capacity to spare and nowhere to go.
    const ctx = context({
      windows: [MONDAY_WINDOW],
      fixedBlocks: [fixedBlock('meeting', '2026-03-23T11:30:00Z', '2026-03-23T12:00:00Z')],
      sequences: [sequence('seq-1', true)],
      schedulables: [
        schedulable({
          occurrenceId: 'a',
          durationMin: 150,
          sequenceId: 'seq-1',
          sequencePosition: 1,
          dueDate: MONDAY + 600,
        }),
        schedulable({
          occurrenceId: 'b',
          durationMin: 150,
          sequenceId: 'seq-1',
          sequencePosition: 2,
        }),
      ],
    });

    const cell = cellOf(computeCapacity({ context: ctx }))!;

    expect(cell.supplyMin).toBe(450);
    expect(cell.longestSequenceMin).toBe(300);
    expect(cell.maxContiguousSpanMin).toBe(240);
    // The totals alone would have called this week fine.
    expect(cell.utilization).toBeLessThan(ONE);
    expect(cell.status).not.toBe('overcommitted');
    expect(cell.hasContiguousSpan).toBe(false);
  });

  it('is satisfied when a single window can hold the block', () => {
    const ctx = context({
      windows: [MONDAY_WINDOW],
      sequences: [sequence('seq-1', true)],
      schedulables: [
        schedulable({
          occurrenceId: 'a',
          durationMin: 120,
          sequenceId: 'seq-1',
          sequencePosition: 1,
          dueDate: MONDAY + 600,
        }),
        schedulable({
          occurrenceId: 'b',
          durationMin: 120,
          sequenceId: 'seq-1',
          sequencePosition: 2,
        }),
      ],
    });

    const cell = cellOf(computeCapacity({ context: ctx }))!;

    expect(cell.longestSequenceMin).toBe(240);
    expect(cell.hasContiguousSpan).toBe(true);
  });

  it('measures the block, not its trailing cooldown', () => {
    // The last member's cooldown is reserved against other tasks and may run
    // past the window edge, exactly as a lone task's may.
    const ctx = context({
      windows: [MONDAY_WINDOW],
      sequences: [sequence('seq-1', true)],
      schedulables: [
        schedulable({
          occurrenceId: 'a',
          durationMin: 60,
          sequenceId: 'seq-1',
          sequencePosition: 1,
          dueDate: MONDAY + 600,
        }),
        schedulable({
          occurrenceId: 'b',
          durationMin: 60,
          cooldownMin: 120,
          sequenceId: 'seq-1',
          sequencePosition: 2,
        }),
      ],
    });

    const cell = cellOf(computeCapacity({ context: ctx }))!;

    expect(cell.longestSequenceMin).toBe(120);
    expect(cell.demandMin).toBe(240);
  });

  it('holds trivially when no sequence wants the category', () => {
    const report = computeCapacity({ context: context({ windows: [MONDAY_WINDOW] }) });

    expect(cellOf(report)?.longestSequenceMin).toBe(0);
    expect(cellOf(report)?.hasContiguousSpan).toBe(true);
  });
});

describe('the report as a whole', () => {
  it('separates categories and calendars', () => {
    const other = { ...MONDAY_WINDOW, ruleId: 'rule-gym', categoryId: 'cat-gym' };

    const report = computeCapacity({
      context: context({ windows: [MONDAY_WINDOW, other] }),
    });

    expect(report.cells.map((cell) => cell.categoryId).sort()).toEqual(['cat-gym', 'cat-work']);
  });

  it('returns cells in a stable order', () => {
    const ctx = context({
      horizon: { start: at('2026-03-23T00:00:00Z'), end: at('2026-04-06T00:00:00Z') },
      windows: [
        TUESDAY_WINDOW,
        MONDAY_WINDOW,
        { ...MONDAY_WINDOW, ruleId: 'rule-gym', categoryId: 'cat-gym' },
      ],
    });

    const keys = computeCapacity({ context: ctx }).cells.map(
      (cell) => `${cell.weekStart} ${cell.calendarId} ${cell.categoryId}`,
    );

    expect(keys).toEqual([...keys].sort());
    expect(computeCapacity({ context: ctx })).toEqual(computeCapacity({ context: ctx }));
  });

  it('does not mutate its input', () => {
    const ctx = context({
      windows: [MONDAY_WINDOW],
      schedulables: [schedulable({ occurrenceId: 'a', durationMin: 60 })],
    });
    const snapshot = JSON.stringify(ctx);

    computeCapacity({ context: ctx });

    expect(JSON.stringify(ctx)).toBe(snapshot);
  });
});
