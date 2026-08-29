import { sql, type SQL } from 'drizzle-orm';
import type { CivilDate, Instant, Interval } from '@ambitime/scheduler';

/**
 * The boundary between stored time and the engine's time.
 *
 * The scheduler is integer minutes and nothing else (spec §6.3) — it has no
 * `Date` in it, deliberately. Postgres stores `timestamptz` at microsecond
 * resolution. Something has to convert, and this is the only place that does,
 * so a rounding decision cannot be made twice and differently.
 *
 * **Rounding is directional, not nearest.** Every conversion below rounds the
 * way that cannot manufacture a schedule the stored value would forbid: a fixed
 * block never shrinks, a deadline never moves later, a not-before never moves
 * earlier. In practice the UI snaps to a 15-minute grid (§13) so nothing is
 * ever off-minute; this is what happens when something is.
 */

const MS_PER_MINUTE = 60_000;

function epochMillis(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Not an ISO-8601 instant: ${iso}`);
  return ms;
}

/** The minute an instant falls in. Use where rounding down is the safe side. */
export function toInstant(iso: string): Instant {
  return Math.floor(epochMillis(iso) / MS_PER_MINUTE);
}

/** The next whole minute. Use where rounding up is the safe side. */
export function toInstantCeil(iso: string): Instant {
  return Math.ceil(epochMillis(iso) / MS_PER_MINUTE);
}

/** Back to the form the database and the command envelope both use. */
export function toIso(instant: Instant): string {
  return new Date(instant * MS_PER_MINUTE).toISOString();
}

/**
 * A half-open `tstzrange` literal (spec §5.1).
 *
 * Written as text rather than built with `tstzrange(...)` so the bound style is
 * visible at the call site: `[start, end)`, always, everywhere.
 */
export function toRangeLiteral(interval: Interval): string {
  return `["${toIso(interval.start)}","${toIso(interval.end)}")`;
}

/** A `YYYY-MM-DD` column value as the engine's zone-free calendar date. */
export function toCivilDate(value: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Not a YYYY-MM-DD date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * A `timestamptz` expression as the ISO-8601 text the functions above read.
 *
 * `tstzrange` endpoints have no Drizzle column type to map them, and the driver
 * would hand back a `Date` for a bare `lower(during)`. Rendering them as ISO in
 * SQL keeps every rounding decision in this file rather than splitting it
 * between here and a query.
 */
export function isoText(expression: SQL | SQL.Aliased): SQL<string> {
  return sql<string>`to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}
