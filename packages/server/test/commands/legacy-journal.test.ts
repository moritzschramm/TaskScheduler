import { describe, expect, it } from 'vitest';
import { readJournal } from '../../src/commands/journal.js';
import type { CommandJournal } from '../../src/commands/journal.js';

/**
 * Undo still works across a rename (migration 0020, spec §12).
 *
 * The log is append-only — `commands` has UPDATE and DELETE revoked from the
 * application role — which is the property that makes it worth trusting and
 * also the property that makes a rename unreachable. `categories` became
 * `activity_types`, and every entry written before that says `categories`
 * still, in a column nothing may rewrite.
 *
 * So the log keeps its own vocabulary and the reader learns it. These tests are
 * what holds the reader to that: undo of a command issued last year has to put
 * a row back into a table that exists.
 */

const CATEGORY = '018f0000-0000-7000-8000-0000000000c1';
const TASK = '018f0000-0000-7000-8000-0000000000a1';

/** Shaped as it was written: the table and the column names of the day. */
const legacy = {
  calendarIds: ['018f0000-0000-7000-8000-0000000000f1'],
  changes: [
    { table: 'categories', id: CATEGORY, before: null, after: { name: 'Work', color: 'blue' } },
    {
      table: 'tasks',
      id: TASK,
      before: { title: 'Wireframes', categoryId: null },
      after: { title: 'Wireframes', categoryId: CATEGORY },
    },
  ],
} as unknown as CommandJournal;

describe('an entry written before the rename', () => {
  it('names the table that exists now', () => {
    const journal = readJournal(structuredClone(legacy));

    expect(journal?.changes[0]?.table).toBe('activity_types');
  });

  it('names the column that exists now, on both sides of the change', () => {
    const journal = readJournal(structuredClone(legacy));
    const task = journal?.changes[1];

    expect(task?.after).toEqual({ title: 'Wireframes', activityTypeId: CATEGORY });
    expect(task?.before).toEqual({ title: 'Wireframes', activityTypeId: null });
  });

  it('keeps everything the rename did not touch', () => {
    // Ids above all: 0020 renames rather than copies, so what a change points
    // at is the same row it always was. A translation that moved an id would
    // be restoring something else.
    const journal = readJournal(structuredClone(legacy));

    expect(journal?.changes.map((change) => change.id)).toEqual([CATEGORY, TASK]);
    expect(journal?.calendarIds).toEqual(legacy.calendarIds);
    expect(journal?.changes[0]?.after).toEqual({ name: 'Work', color: 'blue' });
  });
});

describe('an entry written since', () => {
  it('passes through as it stands', () => {
    const current: CommandJournal = {
      calendarIds: [],
      changes: [
        {
          table: 'availability_windows',
          id: '018f0000-0000-7000-8000-0000000000b1',
          before: null,
          after: { activityTypeId: CATEGORY, weekday: 1 },
        },
      ],
    };

    expect(readJournal(structuredClone(current))).toEqual(current);
  });
});

describe('an entry with nothing to translate', () => {
  it('survives having had its changes dropped', () => {
    // `compact.ts` strips `changes` past the undo window, and `Undo` itself
    // writes an entry with none: neither is a journal to read names out of.
    const stripped = { calendarIds: [], stripped: true } as unknown as CommandJournal;

    expect(readJournal(stripped)).toEqual(stripped);
  });

  it('reads no journal at all as none', () => {
    // `readHistory` selects a literal null when the caller does not want the
    // row images, and that is not the same as an empty change set.
    expect(readJournal(null)).toBeNull();
  });
});
