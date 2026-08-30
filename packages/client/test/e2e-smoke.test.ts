import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
let mounted: ReturnType<typeof mount> | null = null;
const jar = new Map<string, string>();
const inFlight = new Set<Promise<Response>>();

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

    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;

      const pending = (async () => {
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
      })();

      // Tracked so a test can wait for the view to go quiet. Unmounting does
      // not cancel a request already on its way, and one still deriving while
      // the next test truncates the tables deadlocks against its cascade.
      inFlight.add(pending);
      void pending.catch(() => undefined).finally(() => inFlight.delete(pending));
      return pending;
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

  afterEach(async () => {
    mounted?.unmount();
    mounted = null;
    await settle();
  });

  it('renders the week the API derived', async () => {
    const email = `smoke-${Date.now()}@example.test`;
    await seed(email);

    await signIn(email, PASSWORD);
    await loadSession();

    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();

    const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));

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

  /**
   * Plan M11: configuration built through the UI, and the schedule that follows.
   *
   * The assertion at the end is the one that matters — not "the form posted a
   * command" but "the block on the grid moved". A settings screen that writes a
   * perfect row the solver ignores has done nothing, and only a test that walks
   * all the way back to the grid can tell the difference.
   */
  it('changes the schedule from the settings screen', async () => {
    const email = `settings-${Date.now()}@example.test`;
    await seed(email);

    await signIn(email, PASSWORD);
    await loadSession();

    const router = createAppRouter(createMemoryHistory());
    await router.push('/settings');
    await router.isReady();

    const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
    await waitFor(() => wrapper.find('[data-testid="calendar-section"]').exists());

    // A category, created through the form. Its id comes back on the command,
    // which is what lets the page select it without re-reading and guessing.
    await wrapper.find('[data-testid="new-category-name"]').setValue('Exercise');
    await wrapper.find('[data-testid="new-category-cooldown"]').setValue('20');
    await wrapper.find('[data-testid="add-category"]').trigger('click');
    await waitFor(() => wrapper.findAll('[data-testid="category-row"]').length === 2);

    // Read off the inputs, not the row's text: the names live in field values,
    // and the form was re-seeded from the server's answer rather than kept.
    const names = wrapper
      .findAll('[data-testid="category-name"]')
      .map((input) => (input.element as HTMLInputElement).value);
    expect(names).toContain('Exercise');
    expect(wrapper.find('[data-testid="new-category-name"]').element).toHaveProperty('value', '');

    // A working window covering Tuesday afternoons only. Naming one weekday
    // makes every other weekday unworkable (§9.1), which is the whole
    // difference between "unset" and "empty".
    const tuesday = wrapper.find('[data-testid="working-window"] [data-testid="weekday-2"]');
    await wrapper.find('[data-testid="add-range-2"]').trigger('click');
    await flushPromises();

    const times = wrapper
      .find('[data-testid="working-window"] [data-testid="weekday-2"]')
      .findAll('input[type="time"]');
    expect(times).toHaveLength(2);
    await times[0]!.setValue('13:00');
    await times[1]!.setValue('17:00');
    expect(tuesday.exists()).toBe(true);

    await wrapper.find('[data-testid="save-working-window"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="settings-error"]').exists()).toBe(false);

    // Back to the grid, which re-derives from the source the form just changed.
    await router.push('/');
    await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);

    const columns = wrapper.findAll('[data-testid="day-column"]');
    const task = columns[1]?.find('[data-testid="block-task"]');

    // Was 09:00 Berlin (540) before the working window said afternoons only.
    expect(task?.attributes('data-title')).toBe('Tuesday work');
    expect(task?.attributes('data-start-min')).toBe('780');

    // Monday is not a working day now, so the appointment is still drawn — it
    // is a fixed block, not a placement — but nothing is scheduled around it.
    expect(columns[0]?.find('[data-testid="block-appointment"]').exists()).toBe(true);
    expect(columns[0]?.find('[data-testid="block-task"]').exists()).toBe(false);
  });
});

/**
 * Waits until nothing is in flight, chained requests included.
 *
 * A response can start the next request — a save re-reads — so one pass over
 * the set is not enough; it is drained until it stays empty.
 */
async function settle(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
    await flushPromises();
  }
}

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
 * Everything through the API, exactly as a client would — the calendar,
 * category and availability windows included.
 *
 * Until M11 there was no command for those three and this function reached into
 * the tables for them. It no longer needs to, and the returned ids come from
 * what each command reports having created.
 */
async function seed(email: string): Promise<Seeded> {
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

  const command = async (body: unknown) => {
    const response = await server.request('/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`command failed: ${await response.text()}`);
    return (await response.json()) as CommandBody;
  };

  const idOf = (result: CommandBody, entity: string): string => {
    const match = result.created.find((row) => row.entity === entity);
    if (match === undefined) throw new Error(`no ${entity} was created`);
    return match.id;
  };

  const calendarId = idOf(
    await command({
      type: 'CreateCalendar',
      params: { name: 'Primary', timezone: 'Europe/Berlin' },
    }),
    'calendar',
  );

  const categoryId = idOf(
    await command({ type: 'CreateCategory', params: { name: 'Work', defaultCooldownMin: 0 } }),
    'category',
  );

  await command({
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

  await command({
    type: 'AddAppointment',
    params: {
      calendarId,
      title: 'Standup',
      start: '2026-03-23T08:00:00Z',
      end: '2026-03-23T08:30:00Z',
    },
  });

  await command({
    type: 'CreateTask',
    params: { calendarId, title: 'Tuesday work', categoryId, estimatedDurationMin: 60 },
  });

  const created = await command({
    type: 'CreateTask',
    params: { calendarId, title: 'Much later', categoryId, estimatedDurationMin: 60 },
  });

  const blocks = created.schedules[0]!.blocks;
  await command({
    type: 'MoveToBacklog',
    params: { taskId: blocks.find((block) => block.title === 'Much later')!.taskId },
  });

  // The remaining task must land on Tuesday, so Monday is taken up first.
  await command({
    type: 'MoveTask',
    params: {
      taskId: blocks.find((block) => block.title === 'Tuesday work')!.taskId,
      datetime: '2026-03-24T08:00:00Z',
    },
  });

  return { cookie, calendarId, categoryId };
}

interface Seeded {
  cookie: string;
  calendarId: string;
  categoryId: string;
}

interface CommandBody {
  created: { entity: string; id: string }[];
  schedules: { blocks: { taskId: string; title: string }[] }[];
}
