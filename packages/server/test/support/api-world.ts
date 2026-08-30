import { eq } from 'drizzle-orm';
import { tenants } from '../../src/db/schema/index.js';
import { createTestApp, type Signed, type TestApp } from './auth.js';
import { MONDAY_0900, TIME_ZONE } from './world.js';
import type { Database } from '../../src/db/client.js';
import type { CommandRequest, CreatedEntity } from '@ambitime/shared';

/**
 * A signed-in user with a working calendar, reached only over HTTP.
 *
 * The M6 world builds its state by inserting rows and calls `applyCommand`
 * directly, which is right for testing the command layer. This one goes through
 * the API for **everything**, its own calendar and category included: a request
 * is what a client will actually send,
 * and the parts M9 adds — session to context, validation, error mapping,
 * presentation — only exist on that path.
 *
 * The clock is pinned to the same Monday morning the rest of the suite uses, so
 * the schedules these tests assert on are the schedules the M6 and M7 suites
 * already pin.
 */

export interface ApiWorld {
  app: TestApp;
  session: Signed;
  userId: string;
  tenantId: string;
  calendarId: string;
  categoryId: string;
  get: (path: string) => Promise<Response>;
  command: (body: CommandRequest) => Promise<Response>;
  /** The parsed body of a command that is expected to succeed. */
  run: (body: CommandRequest) => Promise<CommandOk>;
}

export interface CommandOk {
  commandId: string;
  seq: string;
  schedules: {
    calendarId: string;
    horizon: { start: string; end: string };
    blocks: { taskId: string; title: string; start: string; end: string }[];
    backlog: { taskId: string; title: string; estimatedWeek: string | null }[];
    diagnostics: { code: string; taskId: string }[];
    unschedulable: { taskId: string; reason: string }[];
  }[];
  created: { entity: CreatedEntity['entity']; id: string }[];
  attention: { appointmentId: string; title: string }[];
}

export async function createApiWorld(db: Database, at: string = MONDAY_0900): Promise<ApiWorld> {
  const app = createTestApp(db, () => new Date(at));
  const session = await app.signUp({ email: `owner-${Date.now()}@example.test`, name: 'Owner' });

  const [personal] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.personalOwnerId, session.userId));
  const tenantId = personal!.id;

  const get = (path: string) => app.as(session, path);

  const command = (body: CommandRequest) =>
    app.as(session, '/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const run = async (body: CommandRequest): Promise<CommandOk> => {
    const response = await command(body);
    if (response.status !== 200) {
      throw new Error(`Command ${body.type} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as CommandOk;
  };

  // Built through commands, over HTTP, exactly as the settings screen will do
  // it. Until M11 there was no command for any of this and the fixture inserted
  // rows on the system path; that it no longer needs to is the milestone.
  const calendarId = created(
    await run({ type: 'CreateCalendar', params: { name: 'Primary', timezone: TIME_ZONE } }),
    'calendar',
  );
  const categoryId = created(
    await run({ type: 'CreateCategory', params: { name: 'Work', defaultCooldownMin: 0 } }),
    'category',
  );

  await run({
    type: 'SetAvailabilityWindows',
    params: {
      calendarId,
      categoryId,
      windows: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    },
  });

  return {
    app,
    session,
    userId: session.userId,
    tenantId,
    calendarId,
    categoryId,
    get,
    command,
    run,
  };
}

/** The single entity of a kind a command created, or a loud failure. */
function created(result: CommandOk, entity: CreatedEntity['entity']): string {
  const matches = result.created.filter((row) => row.entity === entity);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one created ${entity}, got ${matches.length}`);
  }
  return matches[0]!.id;
}
