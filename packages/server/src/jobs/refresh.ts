import { eq } from 'drizzle-orm';
import {
  computeHardHorizon,
  DEFAULT_TUNING,
  type Instant,
  type TuningConfig,
} from '@ambitime/scheduler';
import { calendars } from '../db/schema/index.js';
import { withTenantContext } from '../db/context.js';
import { generateDemand } from '../commands/demand.js';
import { deriveCalendarSchedule } from '../schedule/derive.js';
import { produceSignals } from '../notifications/produce.js';
import { toIso } from '../schedule/instants.js';
import type { CommandContext } from '../commands/context.js';
import type { Database, Transaction } from '../db/client.js';

/**
 * Bringing one calendar up to date at a given `now` (spec §6.1, §8.2, §11).
 *
 * Three things happen on every write already — spawn the demand a new period
 * needs, re-derive, refresh the signals that follow — and all three depend on
 * `now` rather than on anything a user did. Until M15 they only ran when a
 * command happened to arrive, so a calendar nobody touched over a weekend woke
 * on Monday with last fortnight's plan and last fortnight's warnings.
 *
 * Extracted so the job and the write path call the *same* function. Two
 * implementations of "bring this up to date" would drift, and the drift would
 * show as a schedule that changed the moment somebody touched it — which is
 * exactly the impression this exists to remove.
 *
 * **Idempotent, by construction rather than by care.** Everything it does is
 * derived-state replacement: demand tops up to a target, placements are keyed
 * by occurrence, signals replace their set. pg-boss promises at-least-once
 * delivery, so a job that ran twice has to be a job that ran once — and this
 * one is, without a lock or a marker to get wrong.
 */
export interface RefreshInput {
  db: Database;
  tenantId: string;
  /** Whose context the work runs in — the calendar's owner (spec §5.2). */
  userId: string;
  calendarId: string;
  now: Instant;
  config?: TuningConfig;
}

export async function refreshCalendar({
  db,
  tenantId,
  userId,
  calendarId,
  now,
  config = DEFAULT_TUNING,
}: RefreshInput): Promise<void> {
  await withTenantContext(db, { userId, tenantId }, async (tx) => {
    const [calendar] = await tx
      .select({ timezone: calendars.timezone })
      .from(calendars)
      .where(eq(calendars.id, calendarId))
      .limit(1);

    // Gone, or no longer visible to this user. Not an error: a job enqueued a
    // minute ago is allowed to be about something that has since been deleted.
    if (!calendar) return;

    await refreshWithin(tx, {
      tenantId,
      actorId: userId,
      calendarId,
      timeZone: calendar.timezone,
      now,
      config,
    });
  });
}

export interface RefreshWithinInput {
  tenantId: string;
  actorId: string;
  calendarId: string;
  timeZone: string;
  now: Instant;
  config: TuningConfig;
}

/**
 * The same work, inside a transaction the caller already has.
 *
 * The write path uses this one: its command has to be applied, the demand
 * generated, the schedule derived and the signals written in a single
 * transaction, or a reader could catch the three disagreeing.
 */
export async function refreshWithin(
  tx: Transaction,
  { tenantId, actorId, calendarId, timeZone, now, config }: RefreshWithinInput,
): Promise<void> {
  const ctx: CommandContext = {
    tx,
    tenantId,
    actorId,
    now,
    nowIso: toIso(now),
    config,
    journal: [],
  };

  // Demand before the solve that places it: a period that has begun needs its
  // occurrences to exist before anything can put them anywhere (§8.2).
  //
  // The journal is discarded on this path. A job is not a command — it took no
  // decision and there is nothing for undo to reverse (§12); what it produced
  // follows from source state and the passage of time, and putting it back
  // would mean putting time back.
  await generateDemand({
    ctx,
    calendarId,
    timeZone,
    horizon: computeHardHorizon(now, timeZone, config),
    config,
  });

  const derived = await deriveCalendarSchedule({ tx, tenantId, calendarId, now, config });

  await produceSignals({ tx, tenantId, userId: actorId, derived, config });
}
