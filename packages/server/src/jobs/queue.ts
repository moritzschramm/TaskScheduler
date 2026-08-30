import { PgBoss, type Job } from 'pg-boss';
import { asc } from 'drizzle-orm';
import { DEFAULT_TUNING, type TuningConfig } from '@ambitime/scheduler';
import { calendars } from '../db/schema/index.js';
import { withSystemPrivileges } from '../db/context.js';
import { toInstant } from '../schedule/instants.js';
import { refreshCalendar } from './refresh.js';
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
}

export interface Worker {
  boss: PgBoss;
  /** Enqueues a refresh for every calendar. Exposed for tests and for ops. */
  runRollover: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startWorker({
  db,
  databaseUrl,
  clock = () => new Date(),
  config = DEFAULT_TUNING,
  rolloverCron = '5 0 * * 1',
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

  await boss.schedule(ROLLOVER_QUEUE, rolloverCron);

  return {
    boss,
    runRollover,
    // `stop` waits for in-flight handlers rather than cutting them off: a
    // refresh interrupted mid-transaction would roll back and be redelivered,
    // which is safe but wasteful, and a deploy should not cost a re-solve of
    // every calendar.
    stop: () => boss.stop({ graceful: true }),
  };
}
