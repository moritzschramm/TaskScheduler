import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gt, isNotNull, lt, or, sql } from 'drizzle-orm';
import { computeCapacity, DEFAULT_TUNING } from '@ambitime/scheduler';
import { appointments, calendars, taskOccurrences, tasks } from '../db/schema/index.js';
import { requireContext } from '../auth/middleware.js';
import { withRequestContext } from '../auth/context.js';
import { toApiFailure, toValidationFailure } from '../api/errors.js';
import { presentCapacityCell, presentSchedule, presentTaskNode } from '../api/present.js';
import { readCalendarTaskTree } from '../tasks/task-tree.js';
import { readCalendarConfiguration } from '../configuration/read.js';
import { readHistory } from '../commands/history.js';
import { readAudit } from '../audit/read.js';
import { deriveCalendarSchedule } from '../schedule/derive.js';
import { loadScheduleContext } from '../schedule/load-context.js';
import { isoText, toInstant, toInstantCeil, toIso } from '../schedule/instants.js';
import { expandTemplate } from '../schedule/recurrence.js';
import type { AppEnv } from '../app.js';
import type { Auth } from '../auth/auth.js';
import type { Transaction } from '../db/client.js';
import type { Clock } from '../app.js';

/**
 * Reads over the derived schedule (spec §3.4, §6.1, §6.6).
 *
 * **Every one of these re-derives.** The placement cache exists and is
 * up to date, but reading it directly would answer a different question:
 * "where was everything when the last command ran", not "where is everything
 * now". `now` moves continuously, and the horizon moves with it, so a read at
 * 4pm must not hand back a morning's answer including slots that have passed.
 *
 * Re-derivation is cheap — §3.3 says so and means it, a greedy pass over a
 * fortnight — and it keeps the same property the write path has: the schedule
 * is a function of the source, computed the same way whoever asks.
 *
 * Cheap is not free, though, and **one screen must not cost several solves.**
 * `/schedule` therefore answers with everything a solve produces — the
 * placements, the backlog and the capacity reading — rather than leaving a
 * client to ask for each and pay for a fresh solve per question. The separate
 * `/backlog` and `/capacity` endpoints remain for callers that want only one,
 * and neither is on the path any screen takes.
 *
 * The cache is still written on the way through, which is what §3.4 wants it
 * for: a baseline for change detection, not a source of truth.
 */
export function calendarRoutes(auth: Auth, clock: Clock, retentionDays?: number) {
  const range = z.object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  });

  return (
    new Hono<AppEnv>()
      .get('/calendars', requireContext(auth), async (c) => {
        const context = c.get('context');

        const rows = await withRequestContext(c.get('db'), context, (tx) =>
          tx
            .select({ id: calendars.id, name: calendars.name, timezone: calendars.timezone })
            .from(calendars)
            .orderBy(calendars.name),
        );

        return c.json({ calendars: rows }, 200);
      })

      .get(
        '/calendars/:calendarId/schedule',
        requireContext(auth),
        zValidator('query', range, validationHook),
        async (c) => {
          const context = c.get('context');
          const calendarId = c.req.param('calendarId');
          const { from, to } = c.req.valid('query');

          try {
            const body = await withRequestContext(c.get('db'), context, async (tx) => {
              const derived = await deriveCalendarSchedule({
                tx,
                tenantId: context.tenantId,
                calendarId,
                now: nowOf(clock),
                config: DEFAULT_TUNING,
              });

              const window = {
                start: from === undefined ? derived.horizon.start : toInstant(from),
                end: to === undefined ? derived.horizon.end : toInstantCeil(to),
              };

              // Both readings come from this one `derived`, so the grid and
              // the indicator under it cannot disagree (§6.6).
              const report = computeCapacity({
                context: derived.context,
                placements: derived.placements,
                backlog: derived.backlog,
                config: DEFAULT_TUNING,
              });

              return {
                schedule: await presentSchedule({ tx, schedule: derived }),
                fixedBlocks: await readFixedBlocks(
                  tx,
                  calendarId,
                  window,
                  derived.context.calendars[0]?.timeZone ?? 'UTC',
                ),
                completedBlocks: await readCompletedBlocks(tx, calendarId, window),
                capacity: report.cells.map(presentCapacityCell),
              };
            });

            return c.json(body, 200);
          } catch (error) {
            const failure = toApiFailure(error);
            return c.json(failure.body, failure.status);
          }
        },
      )

      .get('/calendars/:calendarId/backlog', requireContext(auth), async (c) => {
        const context = c.get('context');
        const calendarId = c.req.param('calendarId');

        try {
          const body = await withRequestContext(c.get('db'), context, async (tx) => {
            const derived = await deriveCalendarSchedule({
              tx,
              tenantId: context.tenantId,
              calendarId,
              now: nowOf(clock),
              config: DEFAULT_TUNING,
            });

            const presented = await presentSchedule({ tx, schedule: derived });
            return { calendarId, entries: presented.backlog };
          });

          return c.json(body, 200);
        } catch (error) {
          const failure = toApiFailure(error);
          return c.json(failure.body, failure.status);
        }
      })

      .get('/calendars/:calendarId/tasks', requireContext(auth), async (c) => {
        const context = c.get('context');
        const calendarId = c.req.param('calendarId');

        // Source, not derived: the panel has to show tasks that were never
        // placed — a parent, something completed, something with no estimate
        // yet — and the schedule by definition contains none of those.
        const tasks = await withRequestContext(c.get('db'), context, (tx) =>
          readCalendarTaskTree(tx, calendarId),
        );

        return c.json({ calendarId, tasks: tasks.map(presentTaskNode) }, 200);
      })

      /**
       * The solver's **input** (spec §3.3).
       *
       * Every other read hands back the schedule's answer; this one hands back
       * the question, so the client can run the same engine over the same facts
       * and show the result of a gesture before the server has replied.
       *
       * It carries the server's `now` and the horizon derived from it. A client
       * substituting its own clock would get a legitimately different answer
       * and then report it as a mismatch it could not explain (§6.3).
       *
       * A read, not a write path: nothing the client computes from this is ever
       * trusted. The command endpoint remains the only way to change anything,
       * and its answer replaces whatever the client drew.
       */
      .get('/calendars/:calendarId/context', requireContext(auth), async (c) => {
        const context = c.get('context');
        const calendarId = c.req.param('calendarId');

        try {
          const body = await withRequestContext(c.get('db'), context, async (tx) => {
            const loaded = await loadScheduleContext({
              tx,
              calendarId,
              now: nowOf(clock),
              config: DEFAULT_TUNING,
            });

            return { calendarId, context: loaded.context };
          });

          return c.json(body, 200);
        } catch (error) {
          const failure = toApiFailure(error);
          return c.json(failure.body, failure.status);
        }
      })

      /**
       * Source configuration, not a derived view (spec §4.3, §9.1).
       *
       * The only read here that does not re-derive, because there is nothing to
       * derive: what a settings screen edits is the input to the solve, and
       * running one to answer "which weekdays is exercise available" would be
       * computing an answer to a different question.
       */
      .get('/calendars/:calendarId/configuration', requireContext(auth), async (c) => {
        const context = c.get('context');
        const calendarId = c.req.param('calendarId');

        try {
          const body = await withRequestContext(c.get('db'), context, (tx) =>
            readCalendarConfiguration(tx, calendarId, context.userId),
          );

          return c.json(body, 200);
        } catch (error) {
          const failure = toApiFailure(error);
          return c.json(failure.body, failure.status);
        }
      })

      /**
       * The audit view (spec §12).
       *
       * The same log undo folds into stacks, read flat. Not per calendar and
       * not per actor: an audit answers "who changed what in this context", and
       * scoping it to the person asking would make it a diary instead. RLS
       * keeps it to the tenant; §10.2's coarse RBAC is the lever for narrowing
       * it further when there is a reason to.
       */
      .get(
        '/audit',
        requireContext(auth),
        zValidator('query', z.object({ before: z.string().optional() }), validationHook),
        async (c) => {
          const context = c.get('context');
          const { before } = c.req.valid('query');

          const page = await withRequestContext(c.get('db'), context, (tx) =>
            readAudit(tx, before === undefined ? {} : { before }),
          );

          return c.json({ ...page, retentionDays: retentionDays ?? null }, 200);
        },
      )

      /**
       * What undo and redo would do next (spec §7.5).
       *
       * Not per calendar: undo is a personal gesture over the actor's own command
       * log, and what it reverses may have touched any calendar — or, for a
       * configuration change, none in particular.
       */
      .get('/history', requireContext(auth), async (c) => {
        const context = c.get('context');

        // Without the row images: this answers "what would the buttons say",
        // and the images are only needed by the command that presses one.
        const history = await withRequestContext(c.get('db'), context, (tx) =>
          readHistory(
            {
              tx,
              tenantId: context.tenantId,
              actorId: context.userId,
              now: nowOf(clock),
              nowIso: clock().toISOString(),
              config: DEFAULT_TUNING,
              journal: [],
            },
            { withJournal: false },
          ),
        );

        const typesOf = (units: { entries: { type: string }[] }[]): string[] | null => {
          const last = units[units.length - 1];
          return last === undefined ? null : last.entries.map((entry) => entry.type);
        };

        return c.json(
          {
            undoable: typesOf(history.undoable),
            redoable: typesOf(history.redoable),
            truncated: history.truncated,
          },
          200,
        );
      })

      .get('/calendars/:calendarId/capacity', requireContext(auth), async (c) => {
        const context = c.get('context');
        const calendarId = c.req.param('calendarId');

        try {
          const body = await withRequestContext(c.get('db'), context, async (tx) => {
            const derived = await deriveCalendarSchedule({
              tx,
              tenantId: context.tenantId,
              calendarId,
              now: nowOf(clock),
              config: DEFAULT_TUNING,
            });

            // Capacity is computed from the *same* derived result, so the
            // utilization a user sees and the schedule they are looking at
            // cannot disagree (§6.6).
            const report = computeCapacity({
              context: derived.context,
              placements: derived.placements,
              backlog: derived.backlog,
              config: DEFAULT_TUNING,
            });

            return { calendarId, cells: report.cells.map(presentCapacityCell) };
          });

          return c.json(body, 200);
        } catch (error) {
          const failure = toApiFailure(error);
          return c.json(failure.body, failure.status);
        }
      })
  );
}

/**
 * `now`, from the injected clock.
 *
 * Injected rather than read from `Date` directly, and deliberately **not**
 * overridable by anything on the request. A caller that could set `now` could
 * ask what the schedule looks like next Tuesday and be told it as though it
 * were true, or place work in the past. Tests pin it by constructing the app
 * with a different clock, which is a compile-time seam rather than a runtime
 * one that could be left open in production.
 */
function nowOf(clock: Clock): number {
  return toInstant(clock().toISOString());
}

/**
 * What was finished, still drawn where it was finished (spec §3.4, §7.3).
 *
 * A completed occurrence is no longer demand, so the solver never sees it and
 * the derived schedule cannot contain it — which is correct, and is why these
 * are read separately from source state rather than expected to fall out of a
 * solve. The interval was copied onto the occurrence by `CompleteTask`; here it
 * is simply read back for the days on screen.
 *
 * Occurrences completed before the column existed, or finished straight out of
 * the backlog, have no interval and are skipped: there is nowhere to draw them.
 */
async function readCompletedBlocks(
  tx: Transaction,
  calendarId: string,
  window: { start: number; end: number },
) {
  const rows = await tx
    .select({
      occurrenceId: taskOccurrences.id,
      taskId: tasks.id,
      title: tasks.title,
      activityTypeId: tasks.activityTypeId,
      start: isoText(sql`${taskOccurrences.completedStart}`),
      end: isoText(sql`${taskOccurrences.completedEnd}`),
      completedAt: isoText(sql`${taskOccurrences.completedAt}`),
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(tasks.id, taskOccurrences.taskId))
    .where(
      and(
        eq(tasks.calendarId, calendarId),
        eq(taskOccurrences.status, 'completed'),
        isNotNull(taskOccurrences.completedStart),
        // Overlaps the window, rather than starting in it: a block that began
        // before the first day on screen and ran into it is still part of that
        // day and has to be drawn.
        lt(taskOccurrences.completedStart, sql`to_timestamp(${window.end * 60})`),
        gt(taskOccurrences.completedEnd, sql`to_timestamp(${window.start * 60})`),
      ),
    )
    .orderBy(taskOccurrences.completedStart);

  return rows.map((row) => ({
    occurrenceId: row.occurrenceId,
    taskId: row.taskId,
    title: row.title,
    activityTypeId: row.activityTypeId,
    start: row.start!,
    end: row.end!,
    completedAt: row.completedAt!,
  }));
}

async function readFixedBlocks(
  tx: Transaction,
  calendarId: string,
  window: { start: number; end: number },
  timeZone: string,
) {
  const rows = await tx
    .select({
      appointmentId: appointments.id,
      title: appointments.title,
      notes: appointments.notes,
      start: isoText(sql`lower(${appointments.during})`),
      end: isoText(sql`upper(${appointments.during})`),
      version: appointments.version,
      cooldownMin: appointments.cooldownMin,
      isUnavailability: appointments.isUnavailability,
      isInternal: appointments.isInternal,
      status: appointments.status,
      recurrenceRule: appointments.recurrenceRule,
      recurrenceTimezone: appointments.recurrenceTimezone,
      recurrenceExdates: appointments.recurrenceExdates,
      recurrenceParentId: appointments.recurrenceParentId,
      recurrenceOriginalStart: appointments.recurrenceOriginalStart,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.calendarId, calendarId),
        // Cancelled rows are *not* excluded here, only when emitting blocks
        // below: a cancelled override is how "delete just this one" is stored,
        // and it has to be seen in order to suppress the instance it replaced.
        // Filtering it out in SQL would put the deleted occurrence back.
        or(
          isNotNull(appointments.recurrenceRule),
          isNotNull(appointments.recurrenceParentId),
          sql`${appointments.during} && tstzrange(to_timestamp(${window.start * 60}), to_timestamp(${window.end * 60}), '[)')`,
        ),
      ),
    )
    .orderBy(sql`lower(${appointments.during})`);

  /**
   * Templates become one block per instance (spec §8.1).
   *
   * The grid draws instances, not rules, and each has to carry which instance
   * it is: an expanded occurrence has no row and therefore no id, so
   * `occurrenceStart` is what an editor names when it offers "this occurrence"
   * or "this and all future".
   */
  const overridden = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.recurrenceParentId === null || row.recurrenceOriginalStart === null) continue;
    const taken = overridden.get(row.recurrenceParentId) ?? new Set<string>();
    taken.add(toIso(toInstant(row.recurrenceOriginalStart)));
    overridden.set(row.recurrenceParentId, taken);
  }

  const blocks = [];

  for (const row of rows) {
    if (row.status === 'cancelled') continue;

    const { recurrenceRule, recurrenceTimezone, recurrenceExdates, ...block } = row;

    if (recurrenceRule === null) {
      blocks.push({
        ...block,
        occurrenceStart:
          row.recurrenceOriginalStart === null
            ? null
            : toIso(toInstant(row.recurrenceOriginalStart)),
        isRecurring: row.recurrenceParentId !== null,
      });
      continue;
    }

    const taken = overridden.get(row.appointmentId) ?? new Set<string>();

    for (const occurrence of expandTemplate(
      {
        id: row.appointmentId,
        calendarId,
        start: row.start,
        end: row.end,
        rule: recurrenceRule,
        timeZone: recurrenceTimezone ?? timeZone,
        exdates: recurrenceExdates ?? [],
      },
      window,
    )) {
      const occurrenceStart = toIso(occurrence.originalStart);
      if (taken.has(occurrenceStart)) continue;

      blocks.push({
        ...block,
        start: toIso(occurrence.interval.start),
        end: toIso(occurrence.interval.end),
        occurrenceStart,
        isRecurring: true,
      });
    }
  }

  return blocks.sort((a, b) => a.start.localeCompare(b.start));
}

function validationHook(
  result: { success: boolean; error?: z.core.$ZodError },
  c: { json: (body: unknown, status: 400) => Response },
) {
  if (result.success || !result.error) return undefined;

  const failure = toValidationFailure(result.error);
  return c.json(failure.body, 400);
}
