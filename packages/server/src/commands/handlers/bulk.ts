import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Instant, Interval } from '@ambitime/scheduler';
import { appointments, placements, taskOccurrences, tasks } from '../../db/schema/index.js';
import type { AttentionItem, CommandContext, HandlerOutcome } from '../context.js';
import { calendarTimeZone, requireCalendar } from '../entities.js';
import { updateWhere } from '../journal.js';
import { insertUnavailability } from './appointments.js';
import { isoText, toInstant, toInstantCeil, toIso } from '../../schedule/instants.js';
import { dayFromParam, weekFromParam } from '@ambitime/scheduler';
import type { BlockOutDayParams, ClearWeekParams, PostponeRestOfDayParams } from '@ambitime/shared';

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
 * Two mechanisms, for two readings of the same day off. `PostponeRestOfDay` and
 * `ClearWeek` set a **floor**, because a floor is the only thing in the model
 * that says "not before" — clearing the span and re-deriving would put
 * everything back where it was, since nothing would have changed.
 * `BlockOutDay` instead removes the day's capacity, so the reflow falls out of
 * the ordinary solve; see its own comment for why that is the one a person
 * reaches for.
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
 * `BlockOutDay(calendar, date)` — the same day off, said as a fact about the day.
 *
 * Fills the day with unavailability instead of pushing each task past a floor.
 * The reflow then happens for the ordinary reason — there is no capacity left
 * — which means it also *stays* happened: a floor is a one-off instruction and
 * the next command is free to schedule into the day again, while a block is
 * still there tomorrow.
 *
 * **Written as the gaps between what is already booked, not as one 24-hour
 * block.** The exclusion constraint (§5.3) refuses two overlapping blocks in a
 * calendar, so a single whole-day row would be rejected outright by any day
 * with a meeting in it — which is most days worth blocking out. Filling around
 * them is the only version of this that works on a Tuesday.
 *
 * Those meetings then stay exactly where they were, and come back as attention
 * items (§7.2). Being unavailable does not cancel what other people are
 * expecting of you; it means somebody has to tell them, and that somebody is
 * not a scheduler.
 */
export async function blockOutDay(
  params: BlockOutDayParams,
  ctx: CommandContext,
): Promise<HandlerOutcome> {
  await requireCalendar(ctx, params.calendarId);

  const timeZone = await calendarTimeZone(ctx, params.calendarId);
  const day = dayFromParam(params.date, timeZone);

  // A day in progress is blocked from now on, not from midnight. The hours
  // already spent are a record of what happened — completed blocks are drawn in
  // them (§7.3) — and painting them unavailable afterwards would be the one
  // claim here that is not true.
  const span = { start: Math.max(day.start, ctx.now), end: day.end };
  if (span.end <= span.start) return { calendarIds: [params.calendarId] };

  for (const gap of gapsIn(span, await concreteBlocks(ctx, params.calendarId, span))) {
    await insertUnavailability(ctx, params.calendarId, gap);
  }

  return {
    calendarIds: [params.calendarId],
    attention: await appointmentsIn(ctx, params.calendarId, span),
  };
}

/**
 * The blocks in `span` that occupy real time in the table.
 *
 * Recurring templates and their modified occurrences are excluded for the same
 * reason the exclusion constraint excludes them (migration 0008): a template's
 * `during` stands for a series rather than for that one hour. Its expansions
 * are not rows at all, so a recurring meeting on this day will end up sharing
 * its hour with a block — which the engine tolerates exactly as it tolerates
 * two overlapping expansions, and which leaves the day unavailable either way.
 */
async function concreteBlocks(
  ctx: CommandContext,
  calendarId: string,
  span: Interval,
): Promise<Interval[]> {
  const rows = await ctx.tx
    .select({
      startAt: isoText(sql`lower(${appointments.during})`),
      endAt: isoText(sql`upper(${appointments.during})`),
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.calendarId, calendarId),
        ne(appointments.status, 'cancelled'),
        isNull(appointments.recurrenceRule),
        isNull(appointments.recurrenceParentId),
        sql`${appointments.during} && tstzrange(${instant(span.start)}, ${instant(span.end)}, '[)')`,
      ),
    );

  return rows
    .map((row) => ({ start: toInstant(row.startAt), end: toInstantCeil(row.endAt) }))
    .sort((a, b) => a.start - b.start);
}

/**
 * What is left of `span` once `taken` is removed from it.
 *
 * `taken` arrives sorted by start and may overlap itself — the constraint stops
 * concrete blocks colliding, but a modified occurrence is exempt from it — so
 * the cursor only ever moves forward.
 */
function gapsIn(span: Interval, taken: readonly Interval[]): Interval[] {
  const gaps: Interval[] = [];
  let cursor = span.start;

  for (const block of taken) {
    if (block.start > cursor) gaps.push({ start: cursor, end: Math.min(block.start, span.end) });
    cursor = Math.max(cursor, block.end);
    if (cursor >= span.end) return gaps;
  }

  if (cursor < span.end) gaps.push({ start: cursor, end: span.end });
  return gaps;
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
    await updateWhere(ctx, 'tasks', inArray(tasks.id, taskIds), {
      manualFloor: toIso(floor),
      manualBias: null,
    });
  }

  // Appointments that have already finished need nobody's attention.
  const remaining = { start: Math.max(span.start, ctx.now), end: span.end };
  return {
    calendarIds: [calendarId],
    attention: await appointmentsIn(ctx, calendarId, remaining),
  };
}

/**
 * The appointments in `span` a person now has to do something about (§7.2).
 *
 * Unavailability is excluded, and has to be. Those rows are content-free by
 * definition (§7.4) — no title, no participants — so there is nobody to
 * renegotiate with and nothing to name in the notice; the UI would print a
 * blank line saying it needed attention. `BlockOutDay` made the omission
 * obvious by reporting the very blocks it had just written, but it was already
 * wrong for the other two: an afternoon you had marked unavailable last week
 * does not need rescheduling because you are ill today.
 */
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
        eq(appointments.isUnavailability, false),
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
