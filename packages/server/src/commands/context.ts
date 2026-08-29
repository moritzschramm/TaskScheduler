import { eq } from 'drizzle-orm';
import { appointments, tasks } from '../db/schema/index.js';
import { EntityNotFoundError, OptimisticLockError } from './errors.js';
import type { Appointment, Task } from '../db/schema/index.js';
import type { Transaction } from '../db/client.js';
import type { Instant, TuningConfig } from '@ambitime/scheduler';

/**
 * What a handler is handed: the transaction it must do all its work in, who is
 * acting, when, and the tuning in force.
 *
 * `now` is an explicit input here for the same reason it is one in the solver
 * (spec §6.3) — the write path decides which placements are "already past" and
 * which day "the rest of today" means, and neither should depend on when a test
 * happens to run.
 */
export interface CommandContext {
  tx: Transaction;
  tenantId: string;
  actorId: string;
  /** Integer minutes since the epoch — the engine's instant type. */
  now: Instant;
  /** The same instant as ISO text, for `timestamptz` columns. */
  nowIso: string;
  config: TuningConfig;
  /** The optimistic lock from the envelope, if the caller supplied one (§5.4). */
  expectedVersion?: number;
}

/**
 * Something a command deliberately did not do, and a person must.
 *
 * Spec §7.2 says a bulk reflow notifies the user about the day's appointments:
 * external ones they must renegotiate, internal ones the system moves once
 * participants and negotiation exist. Both of those are deferred features
 * (§2.2), so the honest thing for M6 to do is move the tasks, leave the
 * appointments exactly where they are, and say which ones need attention —
 * rather than silently moving a block someone else is depending on.
 */
export interface AttentionItem {
  kind: 'appointment_needs_rescheduling';
  appointmentId: string;
  title: string;
  /** Internal ones are the ones M15 will be able to renegotiate automatically. */
  isInternal: boolean;
}

/** Which calendars a mutation may have changed the schedule of. */
export interface HandlerOutcome {
  calendarIds: string[];
  attention?: AttentionItem[];
}

/**
 * Reads the command's target and holds it for the rest of the transaction.
 *
 * `FOR UPDATE` matters as much as the version comparison: without the row lock,
 * two commands could both read version 4, both find it acceptable, and both
 * write — which is the exact interleaving optimistic locking exists to catch.
 * With it, the second waits and then sees version 5.
 */
export async function lockTask(ctx: CommandContext, taskId: string): Promise<Task> {
  const [row] = await ctx.tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for('update')
    .limit(1);
  if (!row) throw new EntityNotFoundError('task', taskId);

  checkVersion(ctx, 'task', taskId, row.version);
  return row;
}

export async function lockAppointment(
  ctx: CommandContext,
  appointmentId: string,
): Promise<Appointment> {
  const [row] = await ctx.tx
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .for('update')
    .limit(1);
  if (!row) throw new EntityNotFoundError('appointment', appointmentId);

  checkVersion(ctx, 'appointment', appointmentId, row.version);
  return row;
}

/**
 * An absent `expected_version` is not a conflict.
 *
 * The envelope marks it optional (§7.1), and a command issued by something with
 * no prior read — a bulk action, a future NL instruction — has no version to
 * offer. Requiring one would turn the lock from a concurrency guard into a
 * mandatory read-before-write.
 */
export function checkVersion(
  ctx: CommandContext,
  entity: string,
  id: string,
  actualVersion: number,
): void {
  if (ctx.expectedVersion === undefined) return;
  if (ctx.expectedVersion !== actualVersion) {
    throw new OptimisticLockError(entity, id, ctx.expectedVersion, actualVersion);
  }
}
