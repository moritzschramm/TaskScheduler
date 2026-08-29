import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp as createServer } from '@ambitime/server';
import { createAuth } from '@ambitime/server/auth';
import { createDatabase, type DatabaseHandle } from '@ambitime/server/db';
import { runMigrations } from '@ambitime/server/migrate';
import App from '@/App.vue';
import { resetClock, setClock } from '@/lib/clock';
import { createAppRouter } from '@/router';
import { loadSession, signIn } from '@/lib/session';

/**
 * Seed through the real API, render the real client (plan M10).
 *
 * Not a browser test and not a mock. The actual Hono app runs in-process
 * against the actual Postgres, `fetch` is pointed at it, and the actual Vue
 * root is mounted — so what is exercised is the whole path the plan asks about:
 * command → derive → cache → read → parse → grid.
 *
 * The one thing standing in for reality is the network, and that is the piece
 * least likely to be the bug. What this catches is the class of failure unit
 * tests structurally cannot: a schema the server emits and the client refuses,
 * a route mounted at a path the client does not call, a date format that
 * survives every layer and then renders an hour wrong.
 */

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://ambitime:ambitime@localhost:5432/ambitime';

/** Monday 2026-03-23, 09:00 Berlin — the instant the rest of the suite uses. */
const MONDAY_0900 = '2026-03-23T08:00:00Z';
const PASSWORD = 'correct-horse-battery-staple';

let handle: DatabaseHandle;
let server: ReturnType<typeof createServer>;
const jar = new Map<string, string>();

describe('seed via the API, render the client', () => {
  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL);
    handle = createDatabase(TEST_DATABASE_URL, { max: 4 });

    const auth = createAuth({
      db: handle.db,
      secret: 'test-secret-not-for-any-real-deployment-0123456789',
      baseURL: 'http://localhost',
    });

    server = createServer({
      db: handle.db,
      auth,
      requestLogging: false,
      clock: () => new Date(MONDAY_0900),
    });

    // `hc('/')` and the session module both call global fetch with same-origin
    // paths. Routing those into the app is the whole of the "network" here —
    // plus a cookie jar, because the session is an HttpOnly cookie (§10.1) and
    // without one the client would be signed in for exactly one request.
    // The client's clock is pinned to the server's, so the view opens on the
    // week the fixture schedules into rather than on whatever week it is today.
    setClock(() => new Date(MONDAY_0900));

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;

      const headers = new Headers(init?.headers ?? {});
      if (jar.size > 0) {
        headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
      }

      const response = await server.request(path, { ...init, headers });

      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, ...rest] = (pair ?? '').split('=');
        if (name) jar.set(name.trim(), rest.join('='));
      }

      return response;
    });
  });

  afterAll(async () => {
    resetClock();
    vi.unstubAllGlobals();
    await handle?.close();
  });

  beforeEach(async () => {
    // Deleting the principals is enough: every tenant, membership, calendar and
    // task below them is `ON DELETE CASCADE` (§4.2).
    const { users } = await import('@ambitime/server/schema');
    await handle.db.delete(users);
    jar.clear();
  });

  it('renders the week the API derived', async () => {
    const email = `smoke-${Date.now()}@example.test`;
    await seed(email);

    await signIn(email, PASSWORD);
    await loadSession();

    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();

    const wrapper = mount(App, { global: { plugins: [router] } });

    // The reads are real network round trips to a real Postgres, so this waits
    // for them rather than counting microtask turns.
    await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);

    // The shell knows who is signed in and which context they are in (§9.3).
    expect(wrapper.find('[data-testid="active-context"]').text()).toBe('Personal');

    // Monday's column holds the appointment; Tuesday's holds the task.
    const columns = wrapper.findAll('[data-testid="day-column"]');
    expect(columns).toHaveLength(7);
    expect(columns[0]?.attributes('data-day')).toBe('2026-03-23');

    const appointment = columns[0]?.find('[data-testid="block-appointment"]');
    expect(appointment?.attributes('data-title')).toBe('Standup');

    const task = columns[1]?.find('[data-testid="block-task"]');
    expect(task?.attributes('data-title')).toBe('Tuesday work');
    // 09:00 Berlin — the wall clock a person reads, not the UTC instant.
    expect(task?.attributes('data-start-min')).toBe('540');

    // The panels the plan names.
    expect(wrapper.find('[data-testid="task-panel"]').text()).toContain('Tuesday work');
    const backlogged = wrapper.find('[data-testid="backlog-entry"]');
    expect(backlogged.text()).toContain('Much later');
    expect(backlogged.find('[data-testid="estimated-week"]').text()).toMatch(/week of \d{4}-/);
  });
});

/** Flushes and re-renders until `ready` holds, or gives up loudly. */
async function waitFor(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await flushPromises();
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for the client to render the schedule');
}

/**
 * Everything through the API, exactly as a client would.
 *
 * Calendars, categories and windows are the exception — §7 names no command for
 * them, so they are inserted directly, the same seam the server's own API tests
 * use.
 */
async function seed(email: string): Promise<void> {
  const signUp = await server.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Smoke' }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${await signUp.text()}`);

  const cookie = signUp.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

  const { calendars, categories, availabilityWindows } = await import('@ambitime/server/schema');
  const userId = ((await signUp.json()) as { user: { id: string } }).user.id;

  // The tenant comes from the API too: right after sign-up the active context
  // *is* the personal tenant the triggers made (§4.2), so asking is both
  // simpler than querying for it and a check that the linkage happened.
  const me = await server.request('/api/me', { headers: { cookie } });
  const { activeTenantId: tenantId } = (await me.json()) as { activeTenantId: string };

  const [calendar] = await handle.db
    .insert(calendars)
    .values({ tenantId, ownerId: userId, name: 'Primary', timezone: 'Europe/Berlin' })
    .returning({ id: calendars.id });
  const [category] = await handle.db
    .insert(categories)
    .values({ tenantId, name: 'Work', defaultCooldownMin: 0 })
    .returning({ id: categories.id });

  await handle.db.insert(availabilityWindows).values(
    [1, 2, 3, 4, 5].map((weekday) => ({
      tenantId,
      calendarId: calendar!.id,
      categoryId: category!.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  );

  const command = async (body: unknown) => {
    const response = await server.request('/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`command failed: ${await response.text()}`);
    return response.json();
  };

  await command({
    type: 'AddAppointment',
    params: {
      calendarId: calendar!.id,
      title: 'Standup',
      start: '2026-03-23T08:00:00Z',
      end: '2026-03-23T08:30:00Z',
    },
  });

  await command({
    type: 'CreateTask',
    params: {
      calendarId: calendar!.id,
      title: 'Tuesday work',
      categoryId: category!.id,
      estimatedDurationMin: 60,
    },
  });

  const created = (await command({
    type: 'CreateTask',
    params: {
      calendarId: calendar!.id,
      title: 'Much later',
      categoryId: category!.id,
      estimatedDurationMin: 60,
    },
  })) as { schedules: { blocks: { taskId: string; title: string }[] }[] };

  const later = created.schedules[0]!.blocks.find((b) => b.title === 'Much later')!.taskId;
  await command({ type: 'MoveToBacklog', params: { taskId: later } });

  // The remaining task must land on Tuesday, so Monday is taken up first.
  await command({
    type: 'MoveTask',
    params: {
      taskId: created.schedules[0]!.blocks.find((b) => b.title === 'Tuesday work')!.taskId,
      datetime: '2026-03-24T08:00:00Z',
    },
  });
}
