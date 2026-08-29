import { eq } from 'drizzle-orm';
import { availabilityWindows, calendars, categories, tenants } from '../../src/db/schema/index.js';
import { withSystemPrivileges } from '../../src/db/context.js';
import { createTestApp, type Signed, type TestApp } from './auth.js';
import { MONDAY_0900, TIME_ZONE } from './world.js';
import type { Database } from '../../src/db/client.js';
import type { CommandRequest } from '@ambitime/shared';

/**
 * A signed-in user with a working calendar, reached only over HTTP.
 *
 * The M6 world builds its state by inserting rows and calls `applyCommand`
 * directly, which is right for testing the command layer. This one goes through
 * the API for everything it can: a request is what a client will actually send,
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

  // Calendars, categories and availability windows have no commands yet —
  // §7 does not name any, and inventing some would be building a feature the
  // spec has not asked for. Seeded on the system path, as M6 does.
  const { calendarId, categoryId } = await withSystemPrivileges(db, async (tx) => {
    const [calendar] = await tx
      .insert(calendars)
      .values({ tenantId, ownerId: session.userId, name: 'Primary', timezone: TIME_ZONE })
      .returning({ id: calendars.id });
    const [category] = await tx
      .insert(categories)
      .values({ tenantId, name: 'Work', defaultCooldownMin: 0 })
      .returning({ id: categories.id });

    if (!calendar || !category) throw new Error('Failed to build the API world');

    await tx.insert(availabilityWindows).values(
      [1, 2, 3, 4, 5].map((weekday) => ({
        tenantId,
        calendarId: calendar.id,
        categoryId: category.id,
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    );

    return { calendarId: calendar.id, categoryId: category.id };
  });

  const get = (path: string) => app.as(session, path);

  const command = (body: CommandRequest) =>
    app.as(session, '/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

    run: async (body) => {
      const response = await command(body);
      if (response.status !== 200) {
        throw new Error(`Command ${body.type} failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as CommandOk;
    },
  };
}
