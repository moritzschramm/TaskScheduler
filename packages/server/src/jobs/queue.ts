import { PgBoss, type Job } from 'pg-boss';
import { asc } from 'drizzle-orm';
import { DEFAULT_TUNING, type TuningConfig } from '@ambitime/scheduler';
import { calendars } from '../db/schema/index.js';
import { withSystemPrivileges } from '../db/context.js';
import { compactJournals } from '../audit/compact.js';
import { toInstant } from '../schedule/instants.js';
import { refreshCalendar } from './refresh.js';
import { dispatchNotifications } from '../notifications/deliver.js';
import { loggingEmailSender, type EmailSender } from '../notifications/email.js';
import type { Database } from '../db/client.js';
import type { Clock } from '../app.js';

/**
 * Background processing (spec §11: "pg-boss (Postgres-backed) drives reminders,
 * the week-rollover promotion job (§6.1), asynchronous reschedules, and
 * notification dispatch").
 *
 * Postgres-backed on purpose: the queue lives in the same database as the work,
 * so a job and the rows it touches commit or fail together and there is no
 * second store to keep in step.
 *
 * **Reliability.** pg-boss promises at-least-once, which is the honest promise
 * for a queue — exactly-once across a process boundary is not something a
 * queue can offer. The answer is not to try, but to make the work safe to
 * repeat: `refreshCalendar` replaces derived state rather than accumulating it,
 * so a job delivered twice is a job delivered once. Nothing here holds a lock
 * or writes a marker, because neither would be as reliable as the property.
 */

/** Enqueued per calendar by the rollover schedule, and on demand. */
export const REFRESH_QUEUE = 'calendar.refresh';

/** The fan-out itself, so one schedule serves every calendar. */
export const ROLLOVER_QUEUE = 'calendar.rollover';

/** Notification delivery (§11): in-app when online, email when not. */
export const DELIVERY_QUEUE = 'notifications.deliver';

/** Keeping the command log to its promised size (§12). */
export const MAINTENANCE_QUEUE = 'commands.maintain';

export interface RefreshJob {
  tenantId: string;
  userId: string;
  calendarId: string;
}

export interface WorkerOptions {
  db: Database;
  /** The owner connection: pg-boss manages its own schema and its own tables. */
  databaseUrl: string;
  clock?: Clock;
  config?: TuningConfig;
  /**
   * When the rollover fan-out runs.
   *
   * §6.1 puts promotion "at week rollover", and the default is a few minutes
   * after local midnight on Monday — late enough that the new week has begun
   * everywhere the server thinks it has, early enough that a user opening
   * their calendar over breakfast sees the new fortnight already planned.
   *
   * Hourly would also satisfy §6.1 and would cost a full re-derive per
   * calendar per hour; the on-demand path (§6.1's other trigger) is what
   * covers a user who is ahead of the schedule.
   */
  rolloverCron?: string;
  /** Where email goes. Defaults to the logging sender; see `email.ts`. */
  email?: EmailSender;
  /**
   * How often delivery runs.
   *
   * A minute is the smallest interval pg-boss's cron accepts and is the right
   * order for this: an offline user waiting up to a minute for an email is
   * unremarkable, and an online one already has the notification.
   */
  deliveryCron?: string;
  /**
   * When the log is tidied.
   *
   * Nightly, and off-peak, because none of this is urgent: the space a
   * stripped journal gives back was already unreachable, and a day of it is a
   * rounding error against a log measured in months. Doing it on the write
   * path instead would put a scan of one actor's history behind every command
   * to save a few hours of a column nobody can read.
   */
  maintenanceCron?: string;
}

export interface Worker {
  boss: PgBoss;
  /** Enqueues a refresh for every calendar. Exposed for tests and for ops. */
  runRollover: () => Promise<void>;
  /** Sends whatever is waiting. Exposed for tests and for ops. */
  runDelivery: () => Promise<void>;
  /** Prunes and compacts the log. Exposed for tests and for ops. */
  runMaintenance: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startWorker({
  db,
  databaseUrl,
  clock = () => new Date(),
  config = DEFAULT_TUNING,
  rolloverCron = '5 0 * * 1',
  email = loggingEmailSender(),
  deliveryCron = '* * * * *',
  maintenanceCron = '40 3 * * *',
}: WorkerOptions): Promise<Worker> {
  const boss = new PgBoss({ connectionString: databaseUrl });

  // Surfaced rather than swallowed: a queue that has stopped working while the
  // process stays up is the failure mode worth being loud about.
  boss.on('error', (error: unknown) => {
    console.error('pg-boss error', error);
  });

  await boss.start();
  await boss.createQueue(REFRESH_QUEUE);
  await boss.createQueue(ROLLOVER_QUEUE);
  await boss.createQueue(DELIVERY_QUEUE);
  await boss.createQueue(MAINTENANCE_QUEUE);

  const runRollover = async (): Promise<void> => {
    // Read on the system path: a scheduled job acts for everyone, so there is
    // no one tenant context it could run in. Each *unit* of work then runs as
    // the calendar's owner, under RLS, which is where the boundary belongs.
    const rows = await withSystemPrivileges(db, (tx) =>
      tx
        .select({
          calendarId: calendars.id,
          tenantId: calendars.tenantId,
          userId: calendars.ownerId,
        })
        .from(calendars)
        .orderBy(asc(calendars.id)),
    );

    for (const row of rows) {
      await boss.send(REFRESH_QUEUE, row satisfies RefreshJob, {
        // One pending refresh per calendar is enough: they are idempotent and
        // each does the whole job, so a second queued behind the first would
        // only repeat it.
        singletonKey: row.calendarId,
      });
    }
  };

  await boss.work<RefreshJob>(REFRESH_QUEUE, async (jobs: Job<RefreshJob>[]) => {
    for (const job of jobs) {
      await refreshCalendar({
        db,
        tenantId: job.data.tenantId,
        userId: job.data.userId,
        calendarId: job.data.calendarId,
        now: toInstant(clock().toISOString()),
        config,
      });
    }
  });

  await boss.work(ROLLOVER_QUEUE, async () => {
    await runRollover();
  });

  const runDelivery = async (): Promise<void> => {
    await dispatchNotifications({ db, email, now: clock() });
  };

  await boss.work(DELIVERY_QUEUE, async () => {
    await runDelivery();
  });

  /**
   * On the system path, and it has to be — the log has UPDATE and DELETE
   * revoked from `ambitime_app` (§12), which is what makes it append-only for
   * the application. Maintenance is the one thing that is *not* the
   * application, and it runs as the owner for that reason rather than by
   * oversight.
   */
  const runMaintenance = async (): Promise<void> => {
    await withSystemPrivileges(db, (tx) => compactJournals(tx));
  };

  await boss.work(MAINTENANCE_QUEUE, async () => {
    await runMaintenance();
  });

  await boss.schedule(ROLLOVER_QUEUE, rolloverCron);
  await boss.schedule(DELIVERY_QUEUE, deliveryCron);
  await boss.schedule(MAINTENANCE_QUEUE, maintenanceCron);

  return {
    boss,
    runRollover,
    runDelivery,
    runMaintenance,
    // `stop` waits for in-flight handlers rather than cutting them off: a
    // refresh interrupted mid-transaction would roll back and be redelivered,
    // which is safe but wasteful, and a deploy should not cost a re-solve of
    // every calendar.
    stop: () => boss.stop({ graceful: true }),
  };
}
