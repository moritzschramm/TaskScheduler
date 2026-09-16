import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_COMMANDS,
  ASSISTANT_TOOLS,
  COMMAND_TYPES,
  MAX_PROPOSALS_PER_TURN,
  assistantTurnSchema,
  commandSchema,
  isAssistantCommand,
  needsCalendarId,
} from '../src/index.js';

/**
 * The natural-language vocabulary (spec §2.2, §3.2).
 *
 * The property worth holding is that there is **one** vocabulary: what the
 * model is told it may do has to be what the server will accept, or the first
 * anyone hears of the difference is a refusal nobody can explain.
 */

const CALENDAR = '01890000-0000-7000-8000-000000000001';
const TASK = '01890000-0000-7000-8000-000000000002';

describe('the tools offered to a model', () => {
  it('are all commands the server dispatches', () => {
    for (const name of ASSISTANT_COMMANDS) {
      expect(COMMAND_TYPES).toContain(name);
    }
  });

  it('leave configuration, undo and settings alone', () => {
    // Set-replacing configuration is the worst shape for a caller working from
    // a summary, undo is the user's own gesture, and a timezone changed on
    // somebody's behalf changes what every other screen means.
    for (const off of [
      'CreateCategory',
      'DeleteCategory',
      'SetAvailabilityWindows',
      'SetCalendarWindows',
      'CreateWeekTypeOverride',
      'CreateCalendar',
      'UpdateSettings',
      'MarkNotificationsRead',
      'Undo',
      'Redo',
    ]) {
      expect(isAssistantCommand(off)).toBe(false);
    }
  });

  it('never offer a calendar to act on', () => {
    // The assistant works on the planner you are looking at because it is given
    // no way to name another one.
    for (const tool of ASSISTANT_TOOLS) {
      const properties = tool.inputSchema['properties'] as Record<string, unknown>;
      expect(Object.keys(properties)).not.toContain('calendarId');
    }

    expect(needsCalendarId('CreateTask')).toBe(true);
    expect(needsCalendarId('CompleteTask')).toBe(false);
  });

  it('describe every one of them', () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(30);
    }
  });

  it('say what a datetime is without spelling out the grammar', () => {
    // Zod renders `z.iso.datetime()` as the entire ISO-8601 grammar in a
    // regular expression — hundreds of tokens per field, in a tool list that
    // is sent with every message. `format` says the same thing in three words.
    const move = ASSISTANT_TOOLS.find((tool) => tool.name === 'MoveTask');
    const properties = move?.inputSchema['properties'] as Record<string, object>;

    expect(properties['datetime']).toEqual({ type: 'string', format: 'date-time' });
    expect(JSON.stringify(ASSISTANT_TOOLS)).not.toContain('\\\\d{4}');
  });

  it('keep the enumerations, which are the part a caller cannot guess', () => {
    const defer = ASSISTANT_TOOLS.find((tool) => tool.name === 'DeferTask');
    const properties = defer?.inputSchema['properties'] as Record<string, { enum?: string[] }>;

    expect(properties['target']?.enum).toEqual(['tomorrow', 'next_week', 'backlog']);
  });

  it('produce parameters the command union accepts', () => {
    // The end-to-end property: a call shaped by the tool schema, plus the
    // calendar the client injects, is a command the server will validate.
    const request = {
      type: 'CreateTask' as const,
      params: { calendarId: CALENDAR, title: 'Invoices', estimatedDurationMin: 30 },
      id: '01890000-0000-7000-8000-000000000003',
      actor: CALENDAR,
      tenantId: CALENDAR,
      issuedAt: '2026-09-16T09:00:00Z',
    };

    expect(commandSchema.safeParse(request).success).toBe(true);
  });
});

describe('the transcript', () => {
  it('holds a turn with no calls, one with calls, and the answer to them', () => {
    const turns = [
      { role: 'user', text: 'move the invoices to Thursday' },
      {
        role: 'assistant',
        text: 'I can move that.',
        calls: [{ id: 'call_1', command: 'MoveTask', params: { taskId: TASK } }],
      },
      { role: 'outcome', results: [{ id: 'call_1', status: 'declined', detail: 'Not now' }] },
    ];

    for (const turn of turns) {
      expect(assistantTurnSchema.safeParse(turn).success).toBe(true);
    }
  });

  it('refuses a command it was never offered', () => {
    const turn = {
      role: 'assistant',
      text: '',
      calls: [{ id: 'call_1', command: 'DeleteCategory', params: {} }],
    };

    expect(assistantTurnSchema.safeParse(turn).success).toBe(false);
  });

  it('caps a plan at a length somebody will actually read', () => {
    expect(MAX_PROPOSALS_PER_TURN).toBeLessThanOrEqual(20);
  });
});
