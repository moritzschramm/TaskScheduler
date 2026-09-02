import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scheduleResponseSchema } from '@ambitime/shared';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createApiWorld, type ApiWorld } from '../support/api-world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Editing a recurring appointment (spec §8.1).
 *
 * §8.1 requires the two choices by name — "this occurrence only" versus "this
 * and all future occurrences" — and they are the only interesting part: a
 * series edit is an ordinary update, while the other two have to change what a
 * *rule* means without disturbing the instances a user has already arranged.
 *
 * Asserted through the schedule read, because that is where the difference
 * shows. An expanded instance is not a row, so counting rows would be counting
 * the wrong thing.
 */
describe('editing a recurring appointment', () => {
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

  /** A weekly Monday standup, 09:00–09:30 Berlin, from 2026-03-23. */
  async function weeklyStandup(): Promise<string> {
    const result = await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Standup',
        start: '2026-03-23T08:00:00Z',
        end: '2026-03-23T08:30:00Z',
        recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO', timeZone: 'Europe/Berlin' },
      },
    } as never);

    return result.created.find((row) => row.entity === 'appointment')!.id;
  }

  const instances = async () => {
    const response = await world.get(
      `/api/calendars/${world.calendarId}/schedule?from=2026-03-23T00:00:00Z&to=2026-04-20T00:00:00Z`,
    );
    expect(response.status).toBe(200);

    const { fixedBlocks } = scheduleResponseSchema.parse(await response.json());
    return fixedBlocks.map((block) => ({
      title: block.title,
      start: block.start,
      occurrenceStart: block.occurrenceStart,
      isRecurring: block.isRecurring,
    }));
  };

  it('expands one row into an instance per week', async () => {
    await weeklyStandup();
    const blocks = await instances();

    // Four Mondays. The last two are CEST, which is where a recurrence engine
    // that expanded instants rather than wall clocks would drift.
    expect(blocks.map((block) => block.start)).toEqual([
      '2026-03-23T08:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
      '2026-04-06T07:00:00.000Z',
      '2026-04-13T07:00:00.000Z',
    ]);
    expect(blocks.every((block) => block.isRecurring)).toBe(true);
  });

  /**
   * §7.4's other fixed block repeats too.
   *
   * `AddUnavailability` had no `recurrence` parameter at all while the editor
   * offered the control — so "every day, unavailable" was accepted, written to
   * the log, and expanded into exactly one afternoon. Nothing failed; the rule
   * was simply dropped on the way past a schema that had no room for it.
   *
   * The engine has never distinguished the two (§6.2 rule 2): the only
   * difference is that one has words in it, and repeating is not about words.
   */
  it('repeats an unavailability, which had been dropping the rule', async () => {
    await world.run({
      type: 'AddUnavailability',
      params: {
        calendarId: world.calendarId,
        start: '2026-03-23T13:00:00Z',
        end: '2026-03-23T14:00:00Z',
        recurrence: { rule: 'FREQ=DAILY;COUNT=3', timeZone: 'Europe/Berlin' },
      },
    } as never);

    const blocks = await instances();

    expect(blocks.map((block) => block.start)).toEqual([
      '2026-03-23T13:00:00.000Z',
      '2026-03-24T13:00:00.000Z',
      '2026-03-25T13:00:00.000Z',
    ]);
    expect(blocks.every((block) => block.isRecurring)).toBe(true);
    // Content-free, still: §7.4 stores no title and expansion invents none.
    expect(blocks.every((block) => block.title === '')).toBe(true);
  });

  it('moves one occurrence and leaves the rest alone', async () => {
    const appointmentId = await weeklyStandup();

    await world.run({
      type: 'EditAppointment',
      params: {
        appointmentId,
        scope: 'occurrence',
        occurrenceStart: '2026-03-30T07:00:00Z',
        patch: {
          title: 'Standup (later)',
          interval: { start: '2026-03-30T09:00:00Z', end: '2026-03-30T09:30:00Z' },
        },
      },
    } as never);

    const blocks = await instances();

    // The instance is replaced by a row of its own, wherever it was moved to,
    // and every other week keeps expanding exactly as before — which is the
    // whole promise of "only this one".
    expect(blocks.map((block) => `${block.title} ${block.start}`)).toEqual([
      'Standup 2026-03-23T08:00:00.000Z',
      'Standup (later) 2026-03-30T09:00:00.000Z',
      'Standup 2026-04-06T07:00:00.000Z',
      'Standup 2026-04-13T07:00:00.000Z',
    ]);
  });

  it('deletes one occurrence without touching the series', async () => {
    const appointmentId = await weeklyStandup();

    await world.run({
      type: 'EditAppointment',
      params: {
        appointmentId,
        scope: 'occurrence',
        occurrenceStart: '2026-04-06T07:00:00Z',
        patch: { status: 'cancelled' },
      },
    } as never);

    const blocks = await instances();

    // A cancelled override is excluded by status *and* still suppresses the
    // instance it replaced. Either mechanism alone would leave it showing.
    expect(blocks.map((block) => block.start)).toEqual([
      '2026-03-23T08:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
      '2026-04-13T07:00:00.000Z',
    ]);
  });

  it('splits the series for "this and all future"', async () => {
    const appointmentId = await weeklyStandup();

    await world.run({
      type: 'EditAppointment',
      params: {
        appointmentId,
        scope: 'this_and_future',
        occurrenceStart: '2026-04-06T07:00:00Z',
        patch: {
          title: 'Standup (new time)',
          interval: { start: '2026-04-06T08:00:00Z', end: '2026-04-06T08:30:00Z' },
        },
      },
    } as never);

    const blocks = await instances();

    // Two series, not one rule with a discontinuity: RFC 5545 cannot write
    // "Mondays at 09:00 until April and 10:00 after", so the old one is given
    // an UNTIL and a new one carries the change forward.
    expect(blocks.map((block) => `${block.title} ${block.start}`)).toEqual([
      'Standup 2026-03-23T08:00:00.000Z',
      'Standup 2026-03-30T07:00:00.000Z',
      'Standup (new time) 2026-04-06T08:00:00.000Z',
      'Standup (new time) 2026-04-13T08:00:00.000Z',
    ]);
  });

  it('edits the whole series when no scope is given', async () => {
    const appointmentId = await weeklyStandup();

    await world.run({
      type: 'EditAppointment',
      params: { appointmentId, patch: { title: 'Renamed' } },
    } as never);

    const blocks = await instances();
    expect(blocks.every((block) => block.title === 'Renamed')).toBe(true);
    expect(blocks).toHaveLength(4);
  });

  it('refuses a per-occurrence edit that does not say which occurrence', async () => {
    const appointmentId = await weeklyStandup();

    // An instance has no id of its own — it is not a row until something makes
    // it one — so the start is how it is named, and there is no sensible
    // default for "which one".
    const response = await world.command({
      type: 'EditAppointment',
      params: { appointmentId, scope: 'occurrence', patch: { title: 'Which one?' } },
    } as never);

    expect(response.status).toBe(409);
  });

  it('reflows tasks around every instance, not just the first', async () => {
    await weeklyStandup();

    // The point of expanding at all: a recurring meeting is a hard constraint
    // on every week it touches (§6.2 rule 2), not only the week its row
    // happens to sit in.
    const response = await world.get(`/api/calendars/${world.calendarId}/schedule`);
    const { schedule, fixedBlocks } = scheduleResponseSchema.parse(await response.json());

    expect(fixedBlocks.length).toBeGreaterThan(1);
    for (const block of fixedBlocks) {
      const clash = schedule.blocks.some(
        (placed) => placed.start < block.end && placed.end > block.start,
      );
      expect(clash).toBe(false);
    }
  });
});
