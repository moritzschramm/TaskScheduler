import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Instant, Interval } from '@ambitime/scheduler';
import { appointments, placements, taskOccurrences, tasks } from '../../db/schema/index.js';
import type { AttentionItem, CommandContext, HandlerOutcome } from '../context.js';
import { calendarTimeZone } from '../entities.js';
import { toIso } from '../../schedule/instants.js';
import { dayFromParam, weekFromParam } from '../../schedule/local-days.js';
import type { ClearWeekParams, PostponeRestOfDayParams } from '@ambitime/shared';

/**
 * The bulk deferral family (spec §7.2) — the sick day and the vacation.
 *
 * These are **involuntary reflows**, and §6.6 insists they stay distinguishable
 * from a user deferring one task: neither of them touches `defer_count`. A task
 * moved twenty times by sick days has not been avoided by anyone, and flagging
 * it as chronically postponed would call out exactly the tasks the user is
 * least responsible for. The command log records that the reflow happened; the
 * counter records that a person chose to push something.
 *
 * The mechanism is a floor, because a floor is the only thing in the model that
 * says "not before". Clearing the day and re-deriving would put everything back
 * where it was, since nothing would have changed.
 */

/**
 * `PostponeRestOfDay(calendar, date)` — "not today" (spec §7.2).
 *
 * Everything the day holds moves, **except a task under way right now**. §7.2
 * says "incomplete, not-yet-started ... from now forward", and startedness is
 * only observable for the one placement straddling `now`: a slot that passed
 * without a completion says the work did not happen, not that it began. So that
 * is the single exclusion, and the rest of the day — this morning included —
 * clears, which is the only reading under which "not today" means what it says.
 */
export async function postponeRestOfDay(
  params: PostponeRestOfDayParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const timeZone = await calendarTimeZone(ctx, params.calendarId);
  const day = dayFromParam(params.date, timeZone);

  return reflow(ctx, params.calendarId, day, day.end);
}

/**
 * `ClearWeek(calendar, week)` — the vacation (spec §7.2).
 *
 * Tasks reflow into later weeks or, if the horizon cannot hold them, into the
 * backlog with an estimated week — which the solver does on its own once the
 * week is closed to them.
 */
export async function clearWeek(
  params: ClearWeekParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  const timeZone = await calendarTimeZone(ctx, params.calendarId);
  const week = weekFromParam(params.week, timeZone, ctx.config);

  return reflow(ctx, params.calendarId, week, week.end);
}

/**
 * Pushes everything placed in `span` past `floor`.
 *
 * A span already wholly in the past is a no-op: there is nothing left to
 * reschedule, and the floor would push work the user never asked about.
 *
 * Any floor those tasks already carried is replaced, which is §7.3's "floor
 * clears on a bulk reschedule" — a task the user had positioned by hand on this
 * day is exactly the one that must not stay there, and leaving its floor would
 * put it straight back.
 */
async function reflow(
  ctx: CommandContext,
  calendarId: string,
  span: Interval,
  floor: Instant,
): Promise<HandlerOutcome> {
  if (span.end <= ctx.now) return { calendarIds: [calendarId] };

  const affected = await ctx.tx
    .selectDistinct({ taskId: taskOccurrences.taskId })
    .from(placements)
    .innerJoin(taskOccurrences, eq(taskOccurrences.id, placements.occurrenceId))
    .innerJoin(tasks, eq(tasks.id, taskOccurrences.taskId))
    .where(
      and(
        eq(placements.calendarId, calendarId),
        eq(taskOccurrences.status, 'pending'),
        eq(tasks.status, 'active'),
        sql`lower(${placements.during}) >= ${instant(span.start)}`,
        sql`lower(${placements.during}) < ${instant(span.end)}`,
        // The one placement under way at `now` keeps its slot (§7.2). Strictly
        // *under* way: a block starting exactly now has not started yet.
        sql`not (lower(${placements.during}) < ${instant(ctx.now)}
                 and upper(${placements.during}) > ${instant(ctx.now)})`,
      ),
    );

  const taskIds = affected.map((row) => row.taskId);
  if (taskIds.length > 0) {
    await ctx.tx
      .update(tasks)
      .set({ manualFloor: toIso(floor), manualBias: null })
      .where(inArray(tasks.id, taskIds));
  }

  // Appointments that have already finished need nobody's attention.
  const remaining = { start: Math.max(span.start, ctx.now), end: span.end };
  return {
    calendarIds: [calendarId],
    attention: await appointmentsIn(ctx, calendarId, remaining),
  };
}

async function appointmentsIn(
  ctx: CommandContext,
  calendarId: string,
  span: Interval,
): Promise<AttentionItem[]> {
  const rows = await ctx.tx
    .select({
      id: appointments.id,
      title: appointments.title,
      isInternal: appointments.isInternal,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.calendarId, calendarId),
        ne(appointments.status, 'cancelled'),
        sql`${appointments.during} && tstzrange(${instant(span.start)}, ${instant(span.end)}, '[)')`,
      ),
    );

  return rows.map((row) => ({
    kind: 'appointment_needs_rescheduling' as const,
    appointmentId: row.id,
    title: row.title,
    isInternal: row.isInternal,
  }));
}

/** An engine instant as a `timestamptz` the query planner can use an index on. */
function instant(value: Instant) {
  return sql`to_timestamp(${value * 60})`;
}
