import { asc, eq } from 'drizzle-orm';
import {
  availabilityWindows,
  calendars,
  calendarWindows,
  categories,
  weekTypeOverrides,
} from '../db/schema/index.js';
import { CalendarNotFoundError } from '../schedule/load-context.js';
import type { CalendarConfiguration } from '@ambitime/shared';
import type { Transaction } from '../db/client.js';

/**
 * Everything a settings screen needs about one calendar (spec §4.3, §9.1).
 *
 * Read straight from source, with no derivation anywhere: configuration *is*
 * source state, and the schedule that follows from it is a separate read. A
 * settings screen that had to wait for a solve to show a checkbox would be
 * paying for an answer it does not display.
 *
 * Sorted here rather than in the client. The orders are the ones a person reads
 * in — weekday then time for a window, name for a category, date for an
 * override — and putting them in the query means every consumer, including a
 * test asserting on the response, sees the same sequence (§6.3).
 */
export async function readCalendarConfiguration(
  tx: Transaction,
  calendarId: string,
  actorId: string,
): Promise<CalendarConfiguration> {
  const [calendar] = await tx
    .select({
      id: calendars.id,
      name: calendars.name,
      timezone: calendars.timezone,
      visibilityScope: calendars.visibilityScope,
      version: calendars.version,
      ownerId: calendars.ownerId,
    })
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .limit(1);

  // RLS has already made "in another tenant" indistinguishable from "does not
  // exist", which is the answer either way.
  if (!calendar) throw new CalendarNotFoundError(calendarId);

  const [windows, tenantCategories, availability, overrides] = await Promise.all([
    tx
      .select({
        id: calendarWindows.id,
        kind: calendarWindows.kind,
        weekday: calendarWindows.weekday,
        startMin: calendarWindows.startMin,
        endMin: calendarWindows.endMin,
      })
      .from(calendarWindows)
      .where(eq(calendarWindows.calendarId, calendarId))
      .orderBy(
        asc(calendarWindows.kind),
        asc(calendarWindows.weekday),
        asc(calendarWindows.startMin),
      ),

    // Tenant-scoped, so not filtered by calendar: a category is available to
    // every calendar in the tenant, and the screen offers all of them (§4.3).
    tx
      .select({
        id: categories.id,
        name: categories.name,
        defaultCooldownMin: categories.defaultCooldownMin,
        color: categories.color,
        version: categories.version,
      })
      .from(categories)
      .orderBy(asc(categories.name)),

    tx
      .select({
        id: availabilityWindows.id,
        categoryId: availabilityWindows.categoryId,
        weekTypeOverrideId: availabilityWindows.weekTypeOverrideId,
        weekday: availabilityWindows.weekday,
        startMin: availabilityWindows.startMin,
        endMin: availabilityWindows.endMin,
        focusLevel: availabilityWindows.focusLevel,
      })
      .from(availabilityWindows)
      .where(eq(availabilityWindows.calendarId, calendarId))
      .orderBy(
        asc(availabilityWindows.categoryId),
        asc(availabilityWindows.weekday),
        asc(availabilityWindows.startMin),
      ),

    tx
      .select({
        id: weekTypeOverrides.id,
        name: weekTypeOverrides.name,
        startDate: weekTypeOverrides.startDate,
        endDate: weekTypeOverrides.endDate,
        version: weekTypeOverrides.version,
      })
      .from(weekTypeOverrides)
      .where(eq(weekTypeOverrides.calendarId, calendarId))
      .orderBy(asc(weekTypeOverrides.startDate), asc(weekTypeOverrides.id)),
  ]);

  return {
    calendar: {
      id: calendar.id,
      name: calendar.name,
      timezone: calendar.timezone,
      visibilityScope: calendar.visibilityScope,
      version: calendar.version,
      // The configuration commands refuse a calendar the actor does not own
      // (§4.3, §10.2). Saying so here lets a screen show the settings read-only
      // rather than offer edits that will be refused.
      isOwner: calendar.ownerId === actorId,
    },
    windows,
    categories: tenantCategories,
    availability,
    weekTypeOverrides: overrides,
  };
}
