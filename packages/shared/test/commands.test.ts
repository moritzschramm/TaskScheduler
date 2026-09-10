import { describe, expect, it } from 'vitest';
import {
  COMMAND_TYPES,
  commandRequestSchema,
  commandSchema,
  newCommand,
  uuidv7,
} from '../src/index.js';
import type { EditTaskParams } from '../src/index.js';

/**
 * The command vocabulary is a contract between the client and the server (spec
 * §3.2), so what is tested here is the shape of that contract: which intents
 * exist, and which malformed ones the schema refuses to represent at all.
 */

const ACTOR = '018f3a2b-0000-7000-8000-000000000001';
const TENANT = '018f3a2b-0000-7000-8000-000000000002';
const TASK = '018f3a2b-0000-7000-8000-000000000003';

function draft(type: string, params: unknown): unknown {
  return { type, actor: ACTOR, tenantId: TENANT, params };
}

describe('the command envelope (spec §7.1)', () => {
  it('carries the fields the spec names', () => {
    const command = newCommand({
      type: 'MoveTask',
      actor: ACTOR,
      tenantId: TENANT,
      params: { taskId: TASK, datetime: '2026-03-23T09:00:00Z' },
      expectedVersion: 3,
    });

    expect(commandSchema.parse(command)).toMatchObject({
      id: command.id,
      type: 'MoveTask',
      actor: ACTOR,
      tenantId: TENANT,
      expectedVersion: 3,
    });
  });

  it('stamps an id and an issue time, and lets a caller pin both', () => {
    const command = newCommand(
      { type: 'CompleteTask', actor: ACTOR, tenantId: TENANT, params: { taskId: TASK } },
      { id: '018f3a2b-0000-7000-8000-0000000000ff', issuedAt: '2026-03-23T09:00:00Z' },
    );

    expect(command.id).toBe('018f3a2b-0000-7000-8000-0000000000ff');
    expect(command.issuedAt).toBe('2026-03-23T09:00:00Z');
  });

  it('rejects an unknown command type', () => {
    expect(commandSchema.safeParse(newCommand(draft('DropDatabase', {}) as never)).success).toBe(
      false,
    );
  });

  it('covers exactly the §7 command vocabulary and the configuration family', () => {
    expect([...COMMAND_TYPES].sort()).toEqual([
      'AddAppointment',
      'AddUnavailability',
      'BlockOutDay',
      'CancelTask',
      'ClearFloor',
      'ClearWeek',
      'CompleteTask',
      'ConfigureCalendar',
      'CreateCalendar',
      'CreateCategory',
      'CreateTask',
      'CreateWeekTypeOverride',
      'DeferTask',
      'DeleteCategory',
      'DeleteWeekTypeOverride',
      'EditAppointment',
      'EditCategory',
      'EditTask',
      'EditWeekTypeOverride',
      'ExtendTask',
      'MarkNotificationsRead',
      'MoveTask',
      'MoveToBacklog',
      'PostponeRestOfDay',
      'PromoteFromBacklog',
      'Redo',
      'SetAvailabilityWindows',
      'SetCalendarWindows',
      'SwapForward',
      'SwapTasks',
      'Undo',
      'UpdateSettings',
    ]);
  });

  it('offers the same vocabulary over HTTP as in the command layer', () => {
    // `commandRequestSchema` is deliberately a second union — the envelope a
    // caller may send is not the envelope the server applies — which means the
    // two can drift, and a command with no request variant is simply
    // unreachable over HTTP with nothing to say so.
    const overTheWire = commandRequestSchema.options
      .map((option) => option.shape.type.value)
      .sort();

    expect(overTheWire).toEqual([...COMMAND_TYPES].sort());
  });

  it('rejects a time zone the runtime does not know', () => {
    const berlin = draft('CreateCalendar', { name: 'Work', timezone: 'Europe/Berlin' });
    const typo = draft('CreateCalendar', { name: 'Work', timezone: 'Europe/Berln' });

    expect(commandSchema.safeParse(newCommand(berlin as never)).success).toBe(true);
    expect(commandSchema.safeParse(newCommand(typo as never)).success).toBe(false);
  });

  it('addresses a window set, so an empty set means "never available here"', () => {
    const cleared = commandSchema.parse(
      newCommand(
        draft('SetAvailabilityWindows', {
          calendarId: TENANT,
          categoryId: TASK,
          windows: [],
        }) as never,
      ),
    );

    expect(cleared.type).toBe('SetAvailabilityWindows');
    expect(cleared.params).toMatchObject({ windows: [] });
  });

  it('refuses a window that ends before it starts', () => {
    const backwards = draft('SetCalendarWindows', {
      calendarId: TENANT,
      kind: 'working',
      windows: [{ weekday: 1, startMin: 1020, endMin: 540 }],
    });

    expect(commandSchema.safeParse(newCommand(backwards as never)).success).toBe(false);
  });

  it('carries an optional group id, which is what undo reverses atomically', () => {
    const group = '018f3a2b-0000-7000-8000-00000000000a';
    const command = commandSchema.parse(
      newCommand({
        type: 'MoveTask',
        actor: ACTOR,
        tenantId: TENANT,
        groupId: group,
        params: { taskId: TASK, datetime: '2026-03-23T09:00:00Z' },
      }),
    );

    expect(command.groupId).toBe(group);
    // Absent is the normal case: a standalone command is its own unit.
    expect(
      commandSchema.parse(newCommand({ type: 'Undo', actor: ACTOR, tenantId: TENANT, params: {} }))
        .groupId,
    ).toBeUndefined();
  });
});

describe('params the schema refuses to represent', () => {
  const parse = (type: string, params: unknown) =>
    commandSchema.safeParse(newCommand(draft(type, params) as never));

  it('will not take a due date without its kind', () => {
    expect(
      parse('CreateTask', {
        calendarId: TENANT,
        title: 'Taxes',
        dueDate: { date: '2026-03-23T09:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('will not take a preferred range that ends before it starts', () => {
    expect(
      parse('CreateTask', {
        calendarId: TENANT,
        title: 'Deep work',
        preferredRange: { startMin: 600, endMin: 540 },
      }).success,
    ).toBe(false);
  });

  it('will not take an appointment that ends before it starts', () => {
    expect(
      parse('AddAppointment', {
        calendarId: TENANT,
        title: 'Standup',
        start: '2026-03-23T10:00:00Z',
        end: '2026-03-23T09:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('will not take a defer target outside the three the spec names', () => {
    expect(parse('DeferTask', { taskId: TASK, target: 'never' }).success).toBe(false);
  });

  it('will not take a swap of a task with itself', () => {
    expect(parse('SwapTasks', { taskAId: TASK, taskBId: TASK }).success).toBe(false);
    expect(parse('SwapTasks', { taskAId: TASK, taskBId: ACTOR }).success).toBe(true);
  });

  it('will not take a new estimate of zero minutes', () => {
    expect(parse('ExtendTask', { taskId: TASK, newEstimateMin: 0 }).success).toBe(false);
    expect(parse('ExtendTask', { taskId: TASK, newEstimateMin: 90 }).success).toBe(true);
  });

  it('takes an optional title on an unavailability, and an empty one never (§7.4)', () => {
    const params = {
      calendarId: TENANT,
      start: '2026-03-23T13:00:00Z',
      end: '2026-03-23T15:00:00Z',
    };

    // Absent is the ordinary case and still stores nothing, which is what
    // leaves a reader free to label the block in its own language.
    expect(parse('AddUnavailability', params).success).toBe(true);
    expect(parse('AddUnavailability', { ...params, title: 'Dentist' }).data?.params).toEqual({
      ...params,
      title: 'Dentist',
    });
    // `''` is not a title, it is the absence of one said badly: the column
    // already spells that, and two ways to say it is one too many.
    expect(parse('AddUnavailability', { ...params, title: '' }).success).toBe(false);
  });

  it('distinguishes clearing a field from leaving it alone', () => {
    const edit = (patch: EditTaskParams['patch']) =>
      commandSchema.parse(
        newCommand({
          type: 'EditTask',
          actor: ACTOR,
          tenantId: TENANT,
          params: { taskId: TASK, patch },
        }),
      ).params as EditTaskParams;

    // Absent means "leave it inherited or overridden as it is"; null means
    // "drop my override". A plain partial cannot say the second.
    expect(edit({ priority: null }).patch).toEqual({ priority: null });
    expect(edit({}).patch).toEqual({});
  });
});

describe('UUID v7 (spec §5.1)', () => {
  it('sets the version and variant bits', () => {
    const id = uuidv7();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is time-ordered even within a single millisecond', () => {
    // The sub-millisecond counter is the only thing separating these; without
    // it a burst of commands would sort arbitrarily.
    const ids = Array.from({ length: 500 }, () => uuidv7());

    expect([...ids].sort()).toEqual(ids);
  });

  it('does not repeat itself', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());

    expect(new Set(ids).size).toBe(ids.length);
  });
});
