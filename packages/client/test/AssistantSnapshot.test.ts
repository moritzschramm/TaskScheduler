import { describe, expect, it } from 'vitest';
import { renderSnapshot, type SnapshotInput } from '@/lib/snapshot';
import type { CalendarConfiguration } from '@ambitime/shared';

/**
 * The week, written out for a model to read (spec §2.2).
 *
 * This is what makes the assistant answer a question without a round trip:
 * everything on screen is already in the prompt. So the properties worth
 * holding are about completeness and about honesty — every id a tool call could
 * need is present, times are in the calendar's zone rather than UTC, and the
 * reasons something was *not* scheduled are stated rather than left as an
 * absence the model would have to explain away.
 */

const WORK = '01890000-0000-7000-8000-0000000000ca';
const TASK = '01890000-0000-7000-8000-000000000001';
const BLOCK = '01890000-0000-7000-8000-000000000002';

const configuration = {
  calendar: {
    id: 'c1',
    name: 'Personal',
    timezone: 'Europe/Berlin',
    visibilityScope: 'private',
    version: 1,
    isOwner: true,
  },
  windows: [],
  activityTypes: [{ id: WORK, name: 'Work', defaultCooldownMin: 10, color: 'blue', version: 1 }],
  availability: [
    {
      id: 'w1',
      activityTypeId: WORK,
      weekTypeOverrideId: null,
      weekday: 3,
      startMin: 540,
      endMin: 1020,
      focusLevel: null,
    },
  ],
  weekTypeOverrides: [],
} as unknown as CalendarConfiguration;

const HOLIDAY = '01890000-0000-7000-8000-0000000000fa';

/** The same planner with a holiday, and Work given no hours during it. */
const withHoliday = {
  ...configuration,
  weekTypeOverrides: [
    { id: HOLIDAY, name: 'Christmas', startDate: '2026-12-24', endDate: '2027-01-02', version: 1 },
  ],
} as unknown as CalendarConfiguration;

/** A complete task node; the read is Zod-parsed, so none of these is absent. */
function task(overrides: Record<string, unknown> = {}): never {
  return {
    id: TASK,
    parentId: null,
    title: 'Learn Spanish',
    notes: null,
    depth: 1,
    path: [TASK],
    isLeaf: true,
    status: 'active',
    version: 1,
    estimatedDurationMin: null,
    ownActivityTypeId: null,
    effectiveActivityTypeId: null,
    ownPriority: null,
    effectivePriority: null,
    ownDueDate: null,
    effectiveDueDate: null,
    ownDueKind: null,
    effectiveDueKind: null,
    ownPreferredStartMin: null,
    effectivePreferredStartMin: null,
    ownPreferredEndMin: null,
    effectivePreferredEndMin: null,
    ownFocusLevel: null,
    effectiveFocusLevel: null,
    ownCooldownOverrideMin: null,
    effectiveCooldownOverrideMin: null,
    manualFloor: null,
    manualBias: null,
    recurrence: null,
    ...overrides,
  } as never;
}

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    now: '2026-09-16T12:00:00Z',
    zone: 'Europe/Berlin',
    locale: 'en-GB',
    calendar: { id: 'c1', name: 'Personal', timezone: 'Europe/Berlin' },
    configuration,
    schedule: {
      calendarId: 'c1',
      horizon: { start: '2026-09-14T00:00:00Z', end: '2026-09-28T00:00:00Z' },
      blocks: [
        {
          occurrenceId: 'o1',
          taskId: TASK,
          title: 'Invoices',
          activityTypeId: WORK,
          start: '2026-09-16T08:00:00Z',
          end: '2026-09-16T08:45:00Z',
          cooldownMin: 10,
        },
      ],
      backlog: [],
      diagnostics: [],
      unschedulable: [],
    },
    fixedBlocks: [
      {
        appointmentId: BLOCK,
        title: 'Dentist',
        notes: null,
        start: '2026-09-16T07:00:00Z',
        end: '2026-09-16T07:30:00Z',
        version: 1,
        occurrenceStart: null,
        isRecurring: false,
        isUnavailability: false,
        cooldownMin: 20,
        isInternal: false,
        status: 'confirmed',
      },
    ],
    tasks: [],
    backlog: [],
    capacity: [],
    days: [
      { year: 2026, month: 9, day: 14 },
      { year: 2026, month: 9, day: 20 },
    ],
    ...overrides,
  };
}

describe('the schedule as the assistant reads it', () => {
  it('says which instant and which zone everything is in', () => {
    const text = renderSnapshot(input());

    expect(text).toContain('Now: 2026-09-16T12:00:00Z');
    expect(text).toContain('Europe/Berlin');
  });

  it('writes times in the calendar’s zone, not in UTC', () => {
    // 07:00Z in Berlin in September is 09:00. A snapshot that reported the
    // stored instant would have the assistant confidently describing a dentist
    // appointment two hours before it is.
    const text = renderSnapshot(input());

    expect(text).toContain('2026-09-16 09:00–09:30 "Dentist"');
    expect(text).toContain('20m cooldown after');
  });

  it('carries the ids a tool call will need', () => {
    const text = renderSnapshot(input());

    expect(text).toContain(BLOCK);
    expect(text).toContain(`task ${TASK}`);
    expect(text).toContain(WORK);
  });

  it('gives each activity type its hours, because that is why things fit', () => {
    expect(renderSnapshot(input())).toContain('Wed 09:00–17:00');
  });

  it('says outright when a type has no hours at all', () => {
    const bare = {
      ...configuration,
      availability: [],
    } as unknown as CalendarConfiguration;

    expect(renderSnapshot(input({ configuration: bare }))).toContain(
      'no hours set, so nothing is ever placed in it',
    );
  });

  it('lists a special week, and says what having no hours in it means', () => {
    // An override *replaces* the ordinary set, so a type with nothing set
    // during it is not missing information — it is the holiday. A reader shown
    // only the types with hours would conclude the rest carried on as usual.
    const text = renderSnapshot(input({ configuration: withHoliday }));

    expect(text).toContain(`- ${HOLIDAY} "Christmas" from 2026-12-24 up to but not including`);
    expect(text).toContain('"Work": nothing, so it is not available at all during this week');
  });

  it('gives the whole set, because setting hours replaces one', () => {
    // A caller working from a partial list deletes the part it could not see.
    const full = {
      ...configuration,
      availability: [
        ...configuration.availability,
        {
          id: 'w2',
          activityTypeId: WORK,
          weekTypeOverrideId: null,
          weekday: 5,
          startMin: 600,
          endMin: 780,
          focusLevel: 3,
        },
      ],
    } as unknown as CalendarConfiguration;

    expect(renderSnapshot(input({ configuration: full }))).toContain(
      'Wed 09:00–17:00, Fri 10:00–13:00 (focus 3)',
    );
  });

  it('explains a task the solver was never offered', () => {
    const text = renderSnapshot(
      input({
        tasks: [task()],
        schedule: {
          ...input().schedule!,
          unschedulable: [{ taskId: TASK, occurrenceId: 'o2', reason: 'no_duration' }],
        },
      }),
    );

    expect(text).toContain('has no estimate, so there is nothing to place');
  });

  it('says how much of the list it left out', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      task({
        id: `0189${String(index).padStart(4, '0')}-0000-7000-8000-000000000001`,
        title: `Task ${index}`,
      }),
    );

    // A model that thinks the list is complete answers confidently and wrongly;
    // one that knows it is partial asks.
    expect(renderSnapshot(input({ tasks: many }))).toContain('80 more not listed here');
  });
});
