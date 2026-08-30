import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, solve } from '@ambitime/scheduler';
import {
  contextResponseSchema,
  projectCommand,
  scheduleResponseSchema,
  toEngineContext,
  type CommandRequest,
} from '@ambitime/shared';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The claim M12 rests on: **the same facts produce the same schedule on either
 * side of the wire** (spec §3.3, §6.3).
 *
 * The client shows the effect of a gesture before the server has answered. That
 * is only honest if the answer it draws is the answer that arrives — otherwise
 * it is a guess dressed up as a result, and the user watches the schedule move
 * twice.
 *
 * So this test does exactly what the client does: fetch the context, project
 * the command onto it, solve. Then it does what the server does: send the
 * command for real. If those disagree the optimistic path is lying, and the
 * plan's acceptance ("the optimistic result matches the server re-derive in
 * normal cases") is not met.
 *
 * Nothing here is mocked. The projection under test is the one the client
 * imports, and the schedule it is compared against came out of the real write
 * path against a real Postgres.
 */
describe('the optimistic result equals the server re-derive', () => {
  let handle: DatabaseHandle;
  let world: ApiWorld;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createApiWorld(handle.db);
  });

  /** A fixed scenario: three tasks and an appointment, in one working week. */
  async function seedScenario(): Promise<Record<string, string>> {
    await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Standup',
        start: '2026-03-23T08:00:00Z',
        end: '2026-03-23T08:30:00Z',
      },
    });

    const ids: Record<string, string> = {};
    for (const [title, minutes] of [
      ['Write the report', 90],
      ['Review the draft', 60],
      ['Answer the email', 30],
    ] as const) {
      const result = await world.run({
        type: 'CreateTask',
        params: {
          calendarId: world.calendarId,
          title,
          categoryId: world.categoryId,
          estimatedDurationMin: minutes,
        },
      });
      ids[title] = result.created.find((row) => row.entity === 'task')!.id;
    }

    return ids;
  }

  /** What the client would draw: fetch context, project, solve. */
  async function optimistic(command: CommandRequest) {
    const response = await world.get(`/api/calendars/${world.calendarId}/context`);
    expect(response.status).toBe(200);

    const { context } = contextResponseSchema.parse(await response.json());
    const projected = projectCommand({
      context: toEngineContext(context),
      command,
      config: DEFAULT_TUNING,
    });

    expect(projected).not.toBeNull();
    return solve(projected!, { config: DEFAULT_TUNING });
  }

  /** What the server does: apply the command for real, then read it back. */
  async function authoritative(command: CommandRequest) {
    await world.run(command);

    const response = await world.get(`/api/calendars/${world.calendarId}/schedule`);
    const { schedule } = scheduleResponseSchema.parse(await response.json());
    return schedule.blocks
      .map((block) => ({ taskId: block.taskId, start: block.start, end: block.end }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.taskId.localeCompare(b.taskId));
  }

  /** The optimistic placements in the same shape, for a like-for-like compare. */
  function asBlocks(
    result: Awaited<ReturnType<typeof optimistic>>,
    occurrenceToTask: Map<string, string>,
  ) {
    return result.placements
      .map((placement) => ({
        taskId: occurrenceToTask.get(placement.occurrenceId)!,
        start: new Date(placement.interval.start * 60_000).toISOString(),
        end: new Date(placement.interval.end * 60_000).toISOString(),
      }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.taskId.localeCompare(b.taskId));
  }

  async function occurrenceMap(): Promise<Map<string, string>> {
    const response = await world.get(`/api/calendars/${world.calendarId}/context`);
    const { context } = contextResponseSchema.parse(await response.json());
    return new Map(context.schedulables.map((s) => [s.occurrenceId, s.taskId]));
  }

  /** Runs both paths over the same command and asserts they agree. */
  async function bothAgree(command: CommandRequest): Promise<void> {
    const occurrences = await occurrenceMap();
    const predicted = asBlocks(await optimistic(command), occurrences);
    const actual = await authoritative(command);

    // Two empty lists are equal and prove nothing. The scenario always places
    // something, so an empty comparison means the test stopped testing.
    expect(actual.length).toBeGreaterThan(0);
    expect(predicted).toEqual(actual);
  }

  it('agrees on a manual reposition', async () => {
    const ids = await seedScenario();

    // The gesture the plan names first: "dragging a task updates instantly and
    // persists".
    await bothAgree({
      type: 'MoveTask',
      params: { taskId: ids['Write the report']!, datetime: '2026-03-24T13:00:00Z' },
    });
  });

  it('agrees on clearing a floor', async () => {
    const ids = await seedScenario();
    await world.run({
      type: 'MoveTask',
      params: { taskId: ids['Review the draft']!, datetime: '2026-03-25T10:00:00Z' },
    });

    await bothAgree({ type: 'ClearFloor', params: { taskId: ids['Review the draft']! } });
  });

  it('agrees on a deferral, including what "tomorrow" means', async () => {
    const ids = await seedScenario();

    // Both sides call the engine's own `deferFloor`. Two answers to "what does
    // tomorrow mean" would disagree the first time `firstDayOfWeek` changed.
    await bothAgree({
      type: 'DeferTask',
      params: { taskId: ids['Answer the email']!, target: 'tomorrow' },
    });
  });

  it('agrees on an extended estimate', async () => {
    const ids = await seedScenario();

    // A longer task pushes everything after it, so this compares a reflow
    // rather than a single move.
    await bothAgree({
      type: 'ExtendTask',
      params: { taskId: ids['Write the report']!, newEstimateMin: 240 },
    });
  });

  it('agrees on a completion, which frees a slot for what follows', async () => {
    const ids = await seedScenario();

    await bothAgree({ type: 'CompleteTask', params: { taskId: ids['Write the report']! } });
  });

  it('agrees on postponing the rest of a day', async () => {
    const ids = await seedScenario();
    expect(Object.keys(ids)).toHaveLength(3);

    // The plan's other named acceptance: "postpone-rest-of-day reflows the day
    // instantly then confirms with the server".
    await bothAgree({
      type: 'PostponeRestOfDay',
      params: { calendarId: world.calendarId, date: '2026-03-23' },
    });
  });

  it('agrees on a new unavailability, which tasks must flow around', async () => {
    await seedScenario();

    await bothAgree({
      type: 'AddUnavailability',
      params: {
        calendarId: world.calendarId,
        start: '2026-03-23T09:00:00Z',
        end: '2026-03-23T12:00:00Z',
      },
    });
  });

  it('declines to guess at a command it does not model', async () => {
    const ids = await seedScenario();
    const response = await world.get(`/api/calendars/${world.calendarId}/context`);
    const { context } = contextResponseSchema.parse(await response.json());

    // `SwapTasks` consults the validator over a proposed pair and falls back to
    // `SwapForward` when the exchange does not hold — a decision, not a
    // transform. Returning `null` is what makes the client wait rather than
    // draw something it would have to take back.
    expect(
      projectCommand({
        context: toEngineContext(context),
        command: {
          type: 'SwapTasks',
          params: { taskAId: ids['Write the report']!, taskBId: ids['Review the draft']! },
        },
        config: DEFAULT_TUNING,
      }),
    ).toBeNull();
  });
});
