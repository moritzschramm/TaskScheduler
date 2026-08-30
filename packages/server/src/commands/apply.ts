import { DEFAULT_TUNING, type Instant, type TuningConfig } from '@ambitime/scheduler';
import { commandSchema, type Command, type CreatedEntity } from '@ambitime/shared';
import { z } from 'zod';
import { withTenantContext } from '../db/context.js';
import { commands } from '../db/schema/index.js';
import { deriveCalendarSchedule, type DerivedSchedule } from '../schedule/derive.js';
import { toInstant, toIso } from '../schedule/instants.js';
import { CommandValidationError, PreconditionFailedError } from './errors.js';
import { COMMAND_TARGETS, dispatch } from './registry.js';
import { produceSignals } from '../notifications/produce.js';
import { generateDemand } from './demand.js';
import { calendarTimeZone } from './entities.js';
import { computeHardHorizon } from '@ambitime/scheduler';
import type { AttentionItem, CommandContext } from './context.js';
import type { CommandJournal, JournalTable } from './journal.js';
import type { Database } from '../db/client.js';

/**
 * The apply pipeline — the single write path (spec §3.2, §7.1).
 *
 * Validate, apply to source, re-derive, persist the placement cache, append to
 * the log, return the new schedule. All of it in **one transaction**, which is
 * what makes the three stores agree: it is not possible to observe a mutated
 * task beside a cache that predates it, or a log entry for a command that
 * failed halfway.
 *
 * The log is appended last on purpose. It records what happened, so a command
 * that was rejected leaves no trace in it — the audit trail (§12) is a history
 * of the system's state, not of attempts on it. It is also the only point at
 * which the whole change set is known, and the entry carries it: §12 asks that
 * each command record enough to reverse itself, and `journal.ts` has been
 * collecting exactly that while the handler ran.
 */

export interface ApplyOptions {
  config?: TuningConfig;
  /**
   * The instant to apply at. Defaults to the command's own `issued_at`, which
   * is what makes a run reproducible: the same commands over an empty database
   * derive the same schedule twice, because nothing consulted a clock.
   */
  now?: Instant;
}

export interface CommandOutcome {
  command: Command;
  /**
   * The log's strict total order (§12). UUID v7 is time-ordered but can tie;
   * this cannot, and undo has to walk the log backwards unambiguously (§7.5).
   */
  seq: bigint;
  /** One per calendar the command touched, in id order. */
  schedules: DerivedSchedule[];
  /**
   * What the command brought into existence, in the order it did.
   *
   * Read straight off the journal — a change with no `before` image *is* a
   * creation — so it cannot drift from what the handler actually inserted, and
   * no handler has to remember to report it.
   */
  created: CreatedEntity[];
  /** What the command deliberately left for a person to deal with (§7.2). */
  attention: AttentionItem[];
}

/** Journal table to the name the API uses for what lives in it. */
const CREATED_ENTITY: Readonly<Record<JournalTable, CreatedEntity['entity']>> = {
  tasks: 'task',
  task_occurrences: 'occurrence',
  appointments: 'appointment',
  calendars: 'calendar',
  calendar_windows: 'calendar_window',
  categories: 'category',
  availability_windows: 'availability_window',
  week_type_overrides: 'week_type_override',
  notifications: 'notification',
};

/** SQLSTATE for a unique violation — here, a command id already in the log. */
const UNIQUE_VIOLATION = '23505';

/**
 * SQLSTATE for a check constraint or a `RAISE ... USING ERRCODE`.
 *
 * The due-date rule of §4.4 is enforced by a **deferred** trigger, because
 * moving a parent and its children takes several statements and the states in
 * between are legitimately inconsistent. Deferred means it fires at commit —
 * after every handler's `try` has returned — so the only place that can catch
 * it is around the transaction itself.
 */
const CHECK_VIOLATION = '23514';

export async function applyCommand(
  db: Database,
  input: Command,
  options: ApplyOptions = {},
): Promise<CommandOutcome> {
  const command = parseCommand(input);
  assertVersionHasATarget(command);

  // Membership is verified and the RLS context is set here, above the policies
  // — a context cannot vouch for itself. Everything below runs as
  // `ambitime_app`, which is subject to them (§5.2).
  return asCommandFailure(() =>
    withTenantContext(db, { userId: command.actor, tenantId: command.tenantId }, async (tx) => {
      const now = options.now ?? toInstant(command.issuedAt);
      const ctx: CommandContext = {
        tx,
        tenantId: command.tenantId,
        actorId: command.actor,
        now,
        nowIso: options.now === undefined ? command.issuedAt : toIso(now),
        config: options.config ?? DEFAULT_TUNING,
        journal: [],
        ...(command.expectedVersion === undefined
          ? {}
          : { expectedVersion: command.expectedVersion }),
      };

      const outcome = await dispatch(command, ctx);

      // Sorted and deduplicated so a command touching two calendars derives them
      // in one order, whatever order the handler happened to name them in (§6.3).
      const calendarIds = [...new Set(outcome.calendarIds)].sort();
      const schedules: DerivedSchedule[] = [];
      for (const calendarId of calendarIds) {
        // Demand before the solve that places it: a period that has begun needs
        // its occurrences to exist before anything can put them anywhere (§8.2).
        await generateDemandFor(ctx, calendarId);

        const derived = await deriveCalendarSchedule({
          tx,
          tenantId: ctx.tenantId,
          calendarId,
          now: ctx.now,
          config: ctx.config,
        });
        schedules.push(derived);

        // Signals are recomputed from the solve that just ran, in the same
        // transaction (§11). A user cannot see a schedule and its warnings
        // disagree, because there is no moment at which only one of them has
        // been written.
        await produceSignals({
          tx,
          tenantId: ctx.tenantId,
          userId: ctx.actorId,
          derived,
          config: ctx.config,
        });
      }

      const journal: CommandJournal = {
        calendarIds,
        changes: ctx.journal,
        ...(outcome.targets === undefined ? {} : { targets: outcome.targets }),
      };

      return {
        command,
        seq: await appendToLog(ctx, command, journal),
        schedules,
        created: ctx.journal
          .filter((change) => change.before === null)
          .map((change) => ({ entity: CREATED_ENTITY[change.table], id: change.id })),
        attention: outcome.attention ?? [],
      };
    }),
  );
}

/**
 * Turns a constraint the database refused at commit into a sentence.
 *
 * Without this the §4.4 due-date rule reaches a caller as a 500: the trigger is
 * deferred, so it raises after the last handler has returned and there is
 * nothing left inside the transaction to catch it. A 500 says "the server is
 * broken" about a request that was simply not allowed.
 *
 * The message is the constraint's own. The due-date trigger writes one for a
 * person — which task, which container, which dates — and replacing it with
 * something generic would throw away the only part a user can act on.
 */
async function asCommandFailure<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    if ((cause as { code?: unknown }).code === CHECK_VIOLATION) {
      const message = (cause as { message?: unknown }).message;
      throw new PreconditionFailedError(
        typeof message === 'string' ? message : 'That change breaks a rule the data must hold to',
      );
    }
    throw error;
  }
}

function parseCommand(input: Command): Command {
  const parsed = commandSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  throw new CommandValidationError(
    `Not a valid command: ${z.prettifyError(parsed.error)}`,
    parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

/**
 * A lock on nothing is not a lock (spec §5.4).
 *
 * `expected_version` guards the entity a command names. A create has not
 * created it yet and a bulk reflow names a day, so accepting a version for
 * those and quietly doing nothing with it would leave a caller believing it was
 * protected against a concurrent edit.
 */
function assertVersionHasATarget(command: Command): void {
  if (command.expectedVersion === undefined) return;
  if (COMMAND_TARGETS[command.type] !== null) return;

  throw new CommandValidationError(
    `${command.type} names no single entity, so expectedVersion cannot apply to one`,
  );
}

/**
 * Appends the command to the log (spec §7.1, §12).
 *
 * The envelope's id is the log's primary key, so applying the same command
 * twice is refused by the database rather than by a check that could race. That
 * makes a client's retry safe to send: it is either the first application or a
 * clean rejection, never a second set of effects.
 */
async function appendToLog(
  ctx: CommandContext,
  command: Command,
  journal: CommandJournal,
): Promise<bigint> {
  try {
    const [row] = await ctx.tx
      .insert(commands)
      .values({
        id: command.id,
        tenantId: command.tenantId,
        actorId: command.actor,
        type: command.type,
        params: command.params,
        groupId: command.groupId ?? null,
        inverse: journal,
        expectedVersion: command.expectedVersion ?? null,
        issuedAt: command.issuedAt,
      })
      .returning({ seq: commands.seq });

    if (!row) throw new Error('The command log returned no sequence number');
    return row.seq;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) {
      throw new PreconditionFailedError(`Command ${command.id} has already been applied`);
    }
    throw error;
  }
}

/**
 * Spawns any occurrences the horizon now needs (spec §8.2).
 *
 * The horizon is recomputed here rather than taken from the derive that
 * follows, because the generator has to run *before* it: demand that does not
 * exist yet cannot be placed. Both use `computeHardHorizon` over the same
 * `now`, so they are looking at the same fortnight.
 */
async function generateDemandFor(ctx: CommandContext, calendarId: string): Promise<void> {
  const timeZone = await calendarTimeZone(ctx, calendarId);

  await generateDemand({
    ctx,
    calendarId,
    timeZone,
    horizon: computeHardHorizon(ctx.now, timeZone, ctx.config),
    config: ctx.config,
  });
}
