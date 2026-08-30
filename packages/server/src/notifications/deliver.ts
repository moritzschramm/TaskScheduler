import { and, eq, isNull } from 'drizzle-orm';
import { notifications, users } from '../db/schema/index.js';
import { withSystemPrivileges } from '../db/context.js';
import type { EmailSender } from './email.js';
import type { Database, Transaction } from '../db/client.js';
import type { NotificationChannel } from '../db/schema/index.js';

/**
 * Delivering a notification down the right channel (spec §11).
 *
 * "In-app when the user is online; email when offline. Presence: last-seen
 * heartbeat determines online/offline (sufficient for v1)."
 *
 * **In-app delivery is not an action.** A notification is already in the table
 * the client reads, so an online user has it the moment it exists; all this
 * does is record that that is how it reached them. Email is the only channel
 * with work to do, which is why the rule is written as "send unless they are
 * here" rather than as a fan-out to two transports.
 *
 * **Delivery is the one thing that must not be repeated.** Everything else in
 * this system is idempotent by being derived — but an email sent twice is a
 * second email, and no amount of careful recomputation makes that acceptable.
 * `delivered_at` is claimed *before* the send, so a crash mid-send loses a
 * message rather than duplicating one. That is the right way round: a missed
 * warning is recoverable by looking at the app, and a duplicated one is not
 * recoverable at all.
 */

/**
 * How long after a heartbeat a user still counts as online (spec §15's kind of
 * value — expected to change, so it lives with the other tuning).
 *
 * Two minutes is a little longer than a plausible heartbeat interval, so one
 * dropped request does not make somebody look absent while they are staring at
 * the screen.
 */
export const PRESENCE_TIMEOUT_MINUTES = 2;

export interface DispatchInput {
  db: Database;
  email: EmailSender;
  /** The moment presence is judged against. Explicit, so tests can pin it. */
  now: Date;
  /** A cap, so one pass cannot run for ever after an outage. */
  limit?: number;
}

export interface DispatchResult {
  inApp: number;
  emailed: number;
}

export async function dispatchNotifications({
  db,
  email,
  now,
  limit = 200,
}: DispatchInput): Promise<DispatchResult> {
  /**
   * Runs on the system path: delivery serves every user, so there is no one
   * tenant context it could act in — and it reads addresses, which no tenant
   * context is entitled to anyway.
   */
  const pending = await withSystemPrivileges(db, (tx) =>
    tx
      .select({
        id: notifications.id,
        userId: notifications.userId,
        type: notifications.type,
        severity: notifications.severity,
        payload: notifications.payload,
        email: users.email,
        lastSeenAt: users.lastSeenAt,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(and(isNull(notifications.deliveredAt), isNull(notifications.readAt)))
      .orderBy(notifications.createdAt)
      .limit(limit),
  );

  const result: DispatchResult = { inApp: 0, emailed: 0 };

  for (const row of pending) {
    // Parsed rather than compared as text: the driver hands back Postgres's
    // own `2026-03-23 08:59:30+00`, which does not sort against an ISO string.
    const online = isOnline(row.lastSeenAt, now);
    const channel: NotificationChannel = online ? 'in_app' : 'email';

    // Claimed first, and only if nobody else has claimed it: two workers may
    // be running, and the loser of the race must not also send.
    const claimed = await withSystemPrivileges(db, (tx) => claim(tx, row.id, channel, now));
    if (!claimed) continue;

    if (online) {
      // Already in the table the client reads. Nothing to send.
      result.inApp += 1;
      continue;
    }

    await email.send({
      to: row.email,
      subject: subjectFor(row.severity, row.type),
      body: bodyFor(row.payload),
    });
    result.emailed += 1;
  }

  return result;
}

/** `UPDATE … WHERE delivered_at IS NULL` — the claim and the guard in one. */
async function claim(
  tx: Transaction,
  id: string,
  channel: NotificationChannel,
  now: Date,
): Promise<boolean> {
  const claimed = await tx
    .update(notifications)
    .set({ deliveredAt: now.toISOString(), deliveredChannel: channel })
    .where(and(eq(notifications.id, id), isNull(notifications.deliveredAt)))
    .returning({ id: notifications.id });

  return claimed.length > 0;
}

/**
 * A subject that says how much attention this wants before it is opened.
 *
 * The severity distinction §6.5 and §6.7 draw is worth as much in an inbox as
 * on screen — arguably more, because an inbox has no badge colour.
 */
function subjectFor(severity: string, type: string): string {
  const label = type.replaceAll('_', ' ');
  const prefix =
    severity === 'alert' ? 'Action needed' : severity === 'warning' ? 'Heads up' : 'FYI';
  return `Ambitime — ${prefix}: ${label}`;
}

function bodyFor(payload: unknown): string {
  const message = (payload as { message?: unknown } | null)?.message;
  return typeof message === 'string'
    ? message
    : 'Something in your schedule needs your attention. Open Ambitime to see it.';
}

/**
 * Records a heartbeat (spec §11).
 *
 * A plain `UPDATE`, not a command: it is a fact about a browser being open, it
 * takes no decision, and a log of it would be a log of somebody existing. The
 * `IS DISTINCT FROM` guard on `version` does not apply here — this column is
 * outside optimistic locking on purpose, because a heartbeat racing a profile
 * edit should lose neither.
 */
export async function recordHeartbeat(db: Database, userId: string, now: Date): Promise<void> {
  await withSystemPrivileges(db, (tx) =>
    tx.update(users).set({ lastSeenAt: now.toISOString() }).where(eq(users.id, userId)),
  );
}

/** Whether a user counts as present, given their last heartbeat. */
export function isOnline(lastSeenAt: string | null, now: Date): boolean {
  if (lastSeenAt === null) return false;
  return Date.parse(lastSeenAt) >= now.getTime() - PRESENCE_TIMEOUT_MINUTES * 60_000;
}
