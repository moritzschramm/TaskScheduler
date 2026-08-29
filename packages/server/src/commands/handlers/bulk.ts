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
 * Only what has not started yet moves. A task already underway at `now` is
 * neither incomplete-and-untouched nor movable in any useful sense, so it keeps
 * its slot.
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
 * The span is clipped to start at `now`: the past is not reschedulable, and a
 * command issued at noon that moved this morning's finished work would be
 * rewriting history rather than planning.
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
  const from = Math.max(span.start, ctx.now);
  if (from >= span.end) return { calendarIds: [calendarId] };

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
        // Not-yet-started, per §7.2. A block straddling `now` keeps its slot.
        sql`lower(${placements.during}) >= ${instant(from)}`,
        sql`lower(${placements.during}) < ${instant(span.end)}`,
      ),
    );

  const taskIds = affected.map((row) => row.taskId);
  if (taskIds.length > 0) {
    await ctx.tx
      .update(tasks)
      .set({ manualFloor: toIso(floor), manualBias: null })
      .where(inArray(tasks.id, taskIds));
  }

  return {
    calendarIds: [calendarId],
    attention: await appointmentsIn(ctx, calendarId, { start: from, end: span.end }),
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
