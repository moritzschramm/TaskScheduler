import { describe, expect, it } from 'vitest';
import { validateSchedule, type ViolationCode } from '../src/index.js';
import {
  at,
  context,
  fixedBlock,
  MONDAY_WINDOW,
  placement,
  schedulable,
  sequence,
  TUESDAY_WINDOW,
} from './support/fixtures.js';

/**
 * One test per hard constraint in spec §6.2, asserting both that the violation
 * is caught and that the diagnostic identifies it *specifically* — a validator
 * that only answers "invalid" tells a user nothing they can act on.
 */

const codes = (violations: { code: ViolationCode }[]) => violations.map((v) => v.code);

describe('hard-constraint validator (spec §6.2)', () => {
  describe('a valid schedule', () => {
    it('accepts placements that satisfy every rule', () => {
      const a = schedulable({ occurrenceId: 'a', durationMin: 60, cooldownMin: 15 });
      const b = schedulable({ occurrenceId: 'b', durationMin: 30 });

      const result = validateSchedule(context({ schedulables: [a, b] }), [
        placement('a', '2026-03-23T09:00:00Z', 60, 15),
        // Starts exactly when a's cooldown ends: adjacent, not overlapping.
        placement('b', '2026-03-23T10:15:00Z', 30),
      ]);

      expect(result.violations).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('accepts an empty schedule', () => {
      const result = validateSchedule(context(), []);
      expect(result.valid).toBe(true);
    });
  });

  describe('rule 1 — within an availability window of its category', () => {
    it('rejects a placement outside every window', () => {
      const task = schedulable({ occurrenceId: 'a' });

      const result = validateSchedule(context({ schedulables: [task] }), [
        // 05:00Z is before the window opens at 08:00Z.
        placement('a', '2026-03-23T05:00:00Z', 60),
      ]);

      expect(codes(result.violations)).toEqual(['outside_availability_window']);
      expect(result.violations[0]?.occurrenceId).toBe('a');
    });

    it('rejects a placement that only partly overlaps a window', () => {
      const task = schedulable({ occurrenceId: 'a', durationMin: 120 });

      const result = validateSchedule(context({ schedulables: [task] }), [
        // Starts an hour before the window closes but runs past its end.
        placement('a', '2026-03-23T15:00:00Z', 120),
      ]);

      expect(codes(result.violations)).toContain('outside_availability_window');
    });

    it('rejects a placement in another category’s window', () => {
      const task = schedulable({ occurrenceId: 'a', categoryId: 'cat-exercise' });

      const result = validateSchedule(context({ schedulables: [task] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
      ]);

      const violation = result.violations[0];
      expect(violation?.code).toBe('outside_availability_window');
      // Distinguishes "no window at all" from "wrong slot", which are different fixes.
      expect(violation?.message).toContain('no availability window');
    });

    it('lets a cooldown run past the window edge', () => {
      // Spec §6.2 rule 3 reserves the cooldown against other tasks, not against
      // the clock; rule 1 constrains the task's own interval.
      const task = schedulable({ occurrenceId: 'a', durationMin: 60, cooldownMin: 30 });

      const result = validateSchedule(context({ schedulables: [task] }), [
        placement('a', '2026-03-23T15:00:00Z', 60, 30),
      ]);

      expect(result.valid).toBe(true);
    });
  });

  describe('rule 2 — no overlap', () => {
    it('rejects two overlapping placements', () => {
      const a = schedulable({ occurrenceId: 'a' });
      const b = schedulable({ occurrenceId: 'b' });

      const result = validateSchedule(context({ schedulables: [a, b] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
        placement('b', '2026-03-23T09:30:00Z', 60),
      ]);

      expect(codes(result.violations)).toEqual(['placement_overlap']);
      expect(result.violations[0]?.relatedOccurrenceId).toBe('b');
    });

    it('accepts placements that merely touch', () => {
      const a = schedulable({ occurrenceId: 'a' });
      const b = schedulable({ occurrenceId: 'b' });

      const result = validateSchedule(context({ schedulables: [a, b] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
        placement('b', '2026-03-23T10:00:00Z', 60),
      ]);

      expect(result.valid).toBe(true);
    });

    it('rejects a placement overlapping a fixed block', () => {
      const a = schedulable({ occurrenceId: 'a' });

      const result = validateSchedule(
        context({
          schedulables: [a],
          fixedBlocks: [fixedBlock('dentist', '2026-03-23T09:30:00Z', '2026-03-23T10:30:00Z')],
        }),
        [placement('a', '2026-03-23T09:00:00Z', 60)],
      );

      expect(codes(result.violations)).toEqual(['fixed_block_overlap']);
      expect(result.violations[0]?.relatedBlockId).toBe('dentist');
    });

    it('reports each overlapping pair once', () => {
      const a = schedulable({ occurrenceId: 'a' });
      const b = schedulable({ occurrenceId: 'b' });
      const c = schedulable({ occurrenceId: 'c' });

      const result = validateSchedule(context({ schedulables: [a, b, c] }), [
        placement('a', '2026-03-23T09:00:00Z', 180),
        placement('b', '2026-03-23T09:30:00Z', 30),
        placement('c', '2026-03-23T10:30:00Z', 30),
      ]);

      // a overlaps b and a overlaps c: two pairs, not four directed reports.
      expect(codes(result.violations)).toEqual(['placement_overlap', 'placement_overlap']);
    });
  });

  describe('rule 3 — cooldown footprint', () => {
    it('rejects a placement starting inside another’s cooldown', () => {
      const a = schedulable({ occurrenceId: 'a', cooldownMin: 30 });
      const b = schedulable({ occurrenceId: 'b' });

      const result = validateSchedule(context({ schedulables: [a, b] }), [
        placement('a', '2026-03-23T09:00:00Z', 60, 30),
        placement('b', '2026-03-23T10:15:00Z', 30),
      ]);

      const violation = result.violations[0];
      expect(violation?.code).toBe('cooldown_overlap');
      // The occurrence at fault is the intruder, and the limit says where it may start.
      expect(violation?.occurrenceId).toBe('b');
      expect(violation?.relatedOccurrenceId).toBe('a');
      expect(violation?.limit).toBe(at('2026-03-23T10:30:00Z'));
    });

    it('accepts a placement starting exactly when the cooldown ends', () => {
      const a = schedulable({ occurrenceId: 'a', cooldownMin: 30 });
      const b = schedulable({ occurrenceId: 'b' });

      const result = validateSchedule(context({ schedulables: [a, b] }), [
        placement('a', '2026-03-23T09:00:00Z', 60, 30),
        placement('b', '2026-03-23T10:30:00Z', 30),
      ]);

      expect(result.valid).toBe(true);
    });

    it('rejects a cooldown running into a fixed block', () => {
      const a = schedulable({ occurrenceId: 'a', cooldownMin: 30 });

      const result = validateSchedule(
        context({
          schedulables: [a],
          fixedBlocks: [fixedBlock('call', '2026-03-23T10:15:00Z', '2026-03-23T11:00:00Z')],
        }),
        [placement('a', '2026-03-23T09:00:00Z', 60, 30)],
      );

      expect(codes(result.violations)).toEqual(['cooldown_overlap']);
      expect(result.violations[0]?.relatedBlockId).toBe('call');
    });

    it('distinguishes a cooldown clash from a direct overlap', () => {
      // Different fixes: a cooldown clash means "start later", a direct overlap
      // means "this slot is taken".
      const a = schedulable({ occurrenceId: 'a', cooldownMin: 60 });
      const b = schedulable({ occurrenceId: 'b' });
      const ctx = context({ schedulables: [a, b] });

      const cooldownClash = validateSchedule(ctx, [
        placement('a', '2026-03-23T09:00:00Z', 60, 60),
        placement('b', '2026-03-23T10:30:00Z', 30),
      ]);
      const directOverlap = validateSchedule(ctx, [
        placement('a', '2026-03-23T09:00:00Z', 60, 60),
        placement('b', '2026-03-23T09:30:00Z', 30),
      ]);

      expect(codes(cooldownClash.violations)).toEqual(['cooldown_overlap']);
      expect(codes(directOverlap.violations)).toEqual(['placement_overlap']);
    });
  });

  describe('rule 4 — hard due dates', () => {
    it('rejects a placement ending after a hard due date', () => {
      const a = schedulable({
        occurrenceId: 'a',
        dueDate: at('2026-03-23T09:30:00Z'),
        dueKind: 'hard',
      });

      const result = validateSchedule(context({ schedulables: [a] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
      ]);

      const violation = result.violations[0];
      expect(violation?.code).toBe('hard_due_date_missed');
      expect(violation?.limit).toBe(at('2026-03-23T09:30:00Z'));
    });

    it('accepts a placement ending exactly on the due date', () => {
      const a = schedulable({
        occurrenceId: 'a',
        dueDate: at('2026-03-23T10:00:00Z'),
        dueKind: 'hard',
      });

      const result = validateSchedule(context({ schedulables: [a] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
      ]);

      expect(result.valid).toBe(true);
    });

    it('ignores a soft due date', () => {
      // Soft due dates are scored and warned about (§6.5), never enforced.
      const a = schedulable({
        occurrenceId: 'a',
        dueDate: at('2026-03-23T09:30:00Z'),
        dueKind: 'soft',
      });

      const result = validateSchedule(context({ schedulables: [a] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
      ]);

      expect(result.valid).toBe(true);
    });

    it('ignores the cooldown when checking the due date', () => {
      // Spec §6.2 rule 4 is about the placement end, not the footprint end.
      const a = schedulable({
        occurrenceId: 'a',
        dueDate: at('2026-03-23T10:00:00Z'),
        dueKind: 'hard',
        cooldownMin: 60,
      });

      const result = validateSchedule(context({ schedulables: [a] }), [
        placement('a', '2026-03-23T09:00:00Z', 60, 60),
      ]);

      expect(result.valid).toBe(true);
    });
  });

  describe('rule 6 — manual floor', () => {
    it('rejects a placement before the floor', () => {
      const a = schedulable({ occurrenceId: 'a', manualFloor: at('2026-03-23T11:00:00Z') });

      const result = validateSchedule(context({ schedulables: [a] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
      ]);

      const violation = result.violations[0];
      expect(violation?.code).toBe('manual_floor_violated');
      expect(violation?.limit).toBe(at('2026-03-23T11:00:00Z'));
    });

    it('accepts a placement at or after the floor', () => {
      const a = schedulable({ occurrenceId: 'a', manualFloor: at('2026-03-23T11:00:00Z') });
      const ctx = context({ schedulables: [a] });

      expect(validateSchedule(ctx, [placement('a', '2026-03-23T11:00:00Z', 60)]).valid).toBe(true);
      expect(validateSchedule(ctx, [placement('a', '2026-03-23T13:00:00Z', 60)]).valid).toBe(true);
    });

    it('is a floor, not a pin — later placement is fine', () => {
      // Spec §7.3: the task is delayed, not fixed.
      const a = schedulable({ occurrenceId: 'a', manualFloor: at('2026-03-23T09:00:00Z') });

      const result = validateSchedule(context({ schedulables: [a] }), [
        placement('a', '2026-03-23T14:00:00Z', 60),
      ]);

      expect(result.valid).toBe(true);
    });
  });

  describe('rule 5 — sequence contiguity', () => {
    const members = (cooldownMin = 0) => [
      schedulable({ occurrenceId: 's1', sequenceId: 'seq', sequencePosition: 1, cooldownMin }),
      schedulable({ occurrenceId: 's2', sequenceId: 'seq', sequencePosition: 2, cooldownMin }),
      schedulable({ occurrenceId: 's3', sequenceId: 'seq', sequencePosition: 3, cooldownMin }),
    ];

    it('accepts members placed back to back', () => {
      const result = validateSchedule(
        context({ schedulables: members(), sequences: [sequence('seq', true)] }),
        [
          placement('s1', '2026-03-23T09:00:00Z', 60),
          placement('s2', '2026-03-23T10:00:00Z', 60),
          placement('s3', '2026-03-23T11:00:00Z', 60),
        ],
      );

      expect(result.violations).toEqual([]);
    });

    it('counts internal cooldowns as part of the contiguous block', () => {
      // M5 collapses a sequence to summed durations *plus* internal cooldowns,
      // so the next member starts where the previous footprint ends.
      const result = validateSchedule(
        context({ schedulables: members(15), sequences: [sequence('seq', true)] }),
        [
          placement('s1', '2026-03-23T09:00:00Z', 60, 15),
          placement('s2', '2026-03-23T10:15:00Z', 60, 15),
          placement('s3', '2026-03-23T11:30:00Z', 60, 15),
        ],
      );

      expect(result.violations).toEqual([]);
    });

    it('rejects a gap between members', () => {
      const result = validateSchedule(
        context({ schedulables: members(), sequences: [sequence('seq', true)] }),
        [
          placement('s1', '2026-03-23T09:00:00Z', 60),
          placement('s2', '2026-03-23T10:30:00Z', 60),
          placement('s3', '2026-03-23T11:30:00Z', 60),
        ],
      );

      const violation = result.violations.find((v) => v.code === 'sequence_not_contiguous');
      expect(violation?.occurrenceId).toBe('s2');
      expect(violation?.limit).toBe(at('2026-03-23T10:00:00Z'));
      expect(violation?.sequenceId).toBe('seq');
    });

    it('rejects members placed out of order when the sequence is ordered', () => {
      const result = validateSchedule(
        context({ schedulables: members(), sequences: [sequence('seq', true)] }),
        [
          placement('s2', '2026-03-23T09:00:00Z', 60),
          placement('s1', '2026-03-23T10:00:00Z', 60),
          placement('s3', '2026-03-23T11:00:00Z', 60),
        ],
      );

      expect(codes(result.violations)).toContain('sequence_out_of_order');
    });

    it('allows any order when the sequence is unordered', () => {
      const result = validateSchedule(
        context({ schedulables: members(), sequences: [sequence('seq', false)] }),
        [
          placement('s2', '2026-03-23T09:00:00Z', 60),
          placement('s1', '2026-03-23T10:00:00Z', 60),
          placement('s3', '2026-03-23T11:00:00Z', 60),
        ],
      );

      expect(result.violations).toEqual([]);
    });

    it('rejects members split across two windows', () => {
      const result = validateSchedule(
        context({
          schedulables: [
            schedulable({ occurrenceId: 's1', sequenceId: 'seq', sequencePosition: 1 }),
            schedulable({ occurrenceId: 's2', sequenceId: 'seq', sequencePosition: 2 }),
          ],
          sequences: [sequence('seq', true)],
        }),
        [placement('s1', '2026-03-23T15:00:00Z', 60), placement('s2', '2026-03-24T08:00:00Z', 60)],
      );

      expect(codes(result.violations)).toContain('sequence_spans_windows');
      const violation = result.violations.find((v) => v.code === 'sequence_spans_windows');
      expect(violation?.windowRuleId).toBe(TUESDAY_WINDOW.ruleId);
    });

    it('rejects a foreign task placed inside the span', () => {
      const result = validateSchedule(
        context({
          schedulables: [
            schedulable({ occurrenceId: 's1', sequenceId: 'seq', sequencePosition: 1 }),
            schedulable({ occurrenceId: 's2', sequenceId: 'seq', sequencePosition: 2 }),
            schedulable({ occurrenceId: 'foreign' }),
          ],
          sequences: [sequence('seq', true)],
        }),
        [
          placement('s1', '2026-03-23T09:00:00Z', 60),
          placement('s2', '2026-03-23T10:00:00Z', 60),
          placement('foreign', '2026-03-23T09:30:00Z', 30),
        ],
      );

      expect(codes(result.violations)).toContain('sequence_interleaved');
      const violation = result.violations.find((v) => v.code === 'sequence_interleaved');
      expect(violation?.occurrenceId).toBe('foreign');
      expect(violation?.sequenceId).toBe('seq');
    });

    it('ignores a sequence with only one placed member', () => {
      const result = validateSchedule(
        context({
          schedulables: [
            schedulable({ occurrenceId: 's1', sequenceId: 'seq', sequencePosition: 1 }),
            schedulable({ occurrenceId: 's2', sequenceId: 'seq', sequencePosition: 2 }),
          ],
          sequences: [sequence('seq', true)],
        }),
        // s2 was pushed to the backlog; one member cannot be discontiguous.
        [placement('s1', '2026-03-23T09:00:00Z', 60)],
      );

      expect(result.violations).toEqual([]);
    });
  });

  describe('structural problems', () => {
    it('rejects a placement for an unknown occurrence', () => {
      const result = validateSchedule(context(), [placement('ghost', '2026-03-23T09:00:00Z', 60)]);

      expect(codes(result.violations)).toEqual(['unknown_occurrence']);
    });

    it('rejects the same occurrence placed twice', () => {
      const a = schedulable({ occurrenceId: 'a' });

      const result = validateSchedule(context({ schedulables: [a] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
        placement('a', '2026-03-23T13:00:00Z', 60),
      ]);

      expect(codes(result.violations)).toContain('duplicate_placement');
    });
  });

  describe('reporting', () => {
    it('collects every violation rather than stopping at the first', () => {
      const a = schedulable({
        occurrenceId: 'a',
        // Due before the placement even ends, and floored well after it starts.
        dueDate: at('2026-03-23T05:30:00Z'),
        dueKind: 'hard',
        manualFloor: at('2026-03-23T14:00:00Z'),
      });

      const result = validateSchedule(context({ schedulables: [a] }), [
        // Outside the window, past a hard due date, and before its floor.
        placement('a', '2026-03-23T05:00:00Z', 60),
      ]);

      expect(codes(result.violations).sort()).toEqual([
        'hard_due_date_missed',
        'manual_floor_violated',
        'outside_availability_window',
      ]);
    });

    it('names the entities involved in every message', () => {
      const a = schedulable({ occurrenceId: 'a', taskId: 'task-alpha' });
      const b = schedulable({ occurrenceId: 'b', taskId: 'task-beta' });

      const result = validateSchedule(context({ schedulables: [a, b] }), [
        placement('a', '2026-03-23T09:00:00Z', 60),
        placement('b', '2026-03-23T09:30:00Z', 60),
      ]);

      for (const violation of result.violations) {
        expect(violation.message).toMatch(/a|b/);
        expect(violation.message.length).toBeGreaterThan(20);
      }
    });
  });

  it('checks the window a task is actually eligible for', () => {
    // Guards against the validator matching any window in the horizon rather
    // than one belonging to the task's own calendar and category.
    const a = schedulable({ occurrenceId: 'a', calendarId: 'cal-other' });

    const result = validateSchedule(
      context({
        schedulables: [a],
        calendars: [{ id: 'cal-other', timeZone: 'UTC' }],
        windows: [MONDAY_WINDOW],
      }),
      [placement('a', '2026-03-23T09:00:00Z', 60)],
    );

    expect(codes(result.violations)).toEqual(['outside_availability_window']);
  });
});
