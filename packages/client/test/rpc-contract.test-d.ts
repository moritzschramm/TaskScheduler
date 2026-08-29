import { hc } from 'hono/client';
import type { AppType } from '@ambitime/server';
import type {
  BacklogEntry,
  CapacityCell,
  CommandResult,
  ErrorResponse,
  Schedule,
  ScheduledBlock,
} from '@ambitime/shared';

/**
 * A type-level check that the client can consume the RPC contract (plan M9).
 *
 * **Nothing here runs.** It is compiled by the client's own `typecheck`, which
 * already covers `test/**` — deliberately, rather than through Vitest's
 * experimental type-testing runner, which compiled this file and reported no
 * errors while `tsc` was reporting six. A check that cannot fail is worse than
 * no check, because it is also a claim.
 *
 * What it proves is that the types survive the trip from `createApp`'s chained
 * `.route()` calls to `hc<AppType>`. If a route stops being chained, or a
 * handler returns something the shared schema does not describe, this file
 * stops compiling — long before a client discovers at runtime that a field it
 * wanted is not there.
 *
 * Note the `response.status === 200` guards. Hono types a response as the union
 * of every body a handler can return, keyed by status, so the error envelope
 * has to be narrowed away before the success body is reachable. That is the
 * contract doing its job: a client cannot read `schedule` without having
 * considered the failure.
 */

const client = hc<AppType>('http://localhost');

const TASK = '018f3a2b-0000-7000-8000-000000000003';
const CALENDAR = '018f3a2b-0000-7000-8000-000000000004';

/** Compiles only when `Actual` and `Expected` are the same type. */
type Exact<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : never
  : never;

function assertExact<Actual, Expected>(_proof: Exact<Actual, Expected>): void {}

export async function commandEndpointIsTyped(): Promise<void> {
  // The body is the shared discriminated union: `MoveTask` takes a datetime,
  // and sending `DeferTask`'s `target` here would not compile.
  const response = await client.api.commands.$post({
    json: { type: 'MoveTask', params: { taskId: TASK, datetime: '2026-03-23T09:00:00Z' } },
  });

  if (response.status === 200) {
    assertExact<Awaited<ReturnType<typeof response.json>>, CommandResult>(true);
    return;
  }

  assertExact<Awaited<ReturnType<typeof response.json>>, ErrorResponse>(true);
}

export async function readsAreTyped(): Promise<void> {
  const schedule = await client.api.calendars[':calendarId'].schedule.$get({
    param: { calendarId: CALENDAR },
    query: {},
  });

  if (schedule.status === 200) {
    const _body = await schedule.json();
    assertExact<(typeof _body)['schedule'], Schedule>(true);
    assertExact<(typeof _body)['schedule']['blocks'][number], ScheduledBlock>(true);
  }

  const backlog = await client.api.calendars[':calendarId'].backlog.$get({
    param: { calendarId: CALENDAR },
  });

  if (backlog.status === 200) {
    const _body = await backlog.json();
    assertExact<(typeof _body)['entries'][number], BacklogEntry>(true);
  }

  const capacity = await client.api.calendars[':calendarId'].capacity.$get({
    param: { calendarId: CALENDAR },
  });

  if (capacity.status === 200) {
    const _body = await capacity.json();
    assertExact<(typeof _body)['cells'][number], CapacityCell>(true);
  }

  const calendars = await client.api.calendars.$get();
  if (calendars.status === 200) {
    const _body = await calendars.json();
    assertExact<(typeof _body)['calendars'][number]['timezone'], string>(true);
  }

  const notifications = await client.api.notifications.$get();
  if (notifications.status === 200) {
    const _body = await notifications.json();
    assertExact<(typeof _body)['notifications'][number]['id'], string>(true);
  }
}
