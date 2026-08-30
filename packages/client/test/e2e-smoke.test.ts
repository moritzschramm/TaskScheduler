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
import type { TaskNode } from '@ambitime/shared';

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
/** When set, `POST /api/commands` waits on this before the server sees it. */
let held: Promise<void> | null = null;

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
        if (held !== null && path === '/api/commands') await held;

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
    held = null;
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

  /**
   * Plan M11b: a task tree built through the UI, and an inherited property
   * overridden on a child.
   *
   * The acceptance the plan asks for is inheritance being real rather than
   * decorative, so the assertion is on what the *server* says afterwards: the
   * child's own value against its effective one. A form that showed the right
   * thing and sent the wrong patch would pass a markup test and fail this.
   */
  it('builds a task tree and overrides an inherited property', async () => {
    const email = `tree-${Date.now()}@example.test`;
    const { calendarId } = await seed(email);

    await signIn(email, PASSWORD);
    await loadSession();

    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();

    const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
    await waitFor(() => wrapper.findAll('[data-testid="task-row"]').length > 0);

    // A parent with a priority of its own.
    await wrapper.find('[data-testid="add-root-task"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="task-title"]').setValue('Ship the thing');
    await wrapper
      .find('[data-testid="field-priority"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="task-priority"]').setValue('7');
    await wrapper.find('[data-testid="save-task"]').trigger('click');
    await settle();

    const parentRow = wrapper
      .findAll('[data-testid="task-row"]')
      .find((row) => row.text().includes('Ship the thing'));
    expect(parentRow).toBeDefined();

    // A subtask under it, with nothing of its own.
    await parentRow!.find('[data-testid="add-subtask"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-parent"]').text()).toContain('Ship the thing');
    await wrapper.find('[data-testid="task-title"]').setValue('Write the docs');
    await wrapper.find('[data-testid="save-task"]').trigger('click');
    await settle();

    const tasks = await readTasks(calendarId);
    const child = tasks.find((task) => task.title === 'Write the docs')!;

    // Nearest-ancestor-wins, straight from the server: the child set nothing
    // and inherits 7.
    expect(child.depth).toBe(2);
    expect(child.ownPriority).toBeNull();
    expect(child.effectivePriority).toBe(7);

    // Now override it on the child.
    await wrapper
      .findAll('[data-testid="select-task"]')
      .find((button) => button.text() === 'Write the docs')!
      .trigger('click');
    await flushPromises();
    await wrapper
      .find('[data-testid="field-priority"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="task-priority"]').setValue('2');
    await wrapper.find('[data-testid="save-task"]').trigger('click');
    await settle();

    const overridden = (await readTasks(calendarId)).find(
      (task) => task.title === 'Write the docs',
    )!;
    expect(overridden.ownPriority).toBe(2);
    expect(overridden.effectivePriority).toBe(2);

    // And clearing it puts the inheritance back — the half of §4.4 a plain
    // form cannot express at all.
    await wrapper
      .find('[data-testid="field-priority"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="save-task"]').trigger('click');
    await settle();

    const reverted = (await readTasks(calendarId)).find((task) => task.title === 'Write the docs')!;
    expect(reverted.ownPriority).toBeNull();
    expect(reverted.effectivePriority).toBe(7);
  });

  it('refuses a subtask due after its container, in the form', async () => {
    const email = `due-${Date.now()}@example.test`;
    await seed(email);

    await signIn(email, PASSWORD);
    await loadSession();

    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();

    const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
    await waitFor(() => wrapper.findAll('[data-testid="task-row"]').length > 0);

    await wrapper.find('[data-testid="add-root-task"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="task-title"]').setValue('Ship the thing');
    await wrapper
      .find('[data-testid="field-due"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="task-due"]').setValue('2026-03-27T17:00');
    await wrapper.find('[data-testid="save-task"]').trigger('click');
    await settle();

    const parentRow = wrapper
      .findAll('[data-testid="task-row"]')
      .find((row) => row.text().includes('Ship the thing'))!;
    await parentRow.find('[data-testid="add-subtask"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-testid="task-title"]').setValue('Write the docs');
    await wrapper
      .find('[data-testid="field-due"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="task-due"]').setValue('2026-04-03T17:00');
    await flushPromises();

    // Said in the form, before the round trip — the database would refuse it
    // too, with a deferred trigger, but only after the typing was done.
    expect(wrapper.find('[data-testid="due-conflict"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-task"]').attributes('disabled')).toBeDefined();
  });

  /** Plan M11b: fixed blocks, made from the grid. */
  it('adds an appointment from the week grid', async () => {
    const email = `appt-${Date.now()}@example.test`;
    await seed(email);

    await signIn(email, PASSWORD);
    await loadSession();

    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();

    const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
    await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);

    // Wednesday's "+" seeds the editor with Wednesday, not with today.
    await wrapper.findAll('[data-testid="add-block"]')[2]!.trigger('click');
    await flushPromises();
    expect(
      (wrapper.find('[data-testid="appointment-start"]').element as HTMLInputElement).value,
    ).toBe('2026-03-25T09:00');

    await wrapper.find('[data-testid="appointment-title"]').setValue('Design review');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');
    await settle();

    const columns = wrapper.findAll('[data-testid="day-column"]');
    expect(columns[2]!.find('[data-testid="block-appointment"]').attributes('data-title')).toBe(
      'Design review',
    );
  });

  it('surfaces the overlap refusal as a sentence', async () => {
    const email = `overlap-${Date.now()}@example.test`;
    await seed(email);

    await signIn(email, PASSWORD);
    await loadSession();

    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();

    const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
    await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);

    // The seed put "Standup" on Monday 09:00–09:30 Berlin.
    await wrapper.findAll('[data-testid="add-block"]')[0]!.trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="appointment-title"]').setValue('Clash');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');
    await settle();

    // The exclusion constraint is the authority (§5.3); what reaches the user
    // is the sentence the command layer wrote about it.
    expect(wrapper.find('[data-testid="calendar-error"]').text()).toContain('overlaps');
  });

  /**
   * Plan M12a: the manual actions of spec §7.3, each from the UI.
   *
   * One sign-in and one mount for all of them, because the interesting thing is
   * the *sequence* — a floor set by a drag, then cleared, then a defer on top —
   * and each assertion is against what the server says afterwards rather than
   * against the markup that asked for it.
   */
  describe('manual actions', () => {
    let wrapper: ReturnType<typeof mount>;
    let calendarId: string;

    const taskNamed = async (title: string): Promise<TaskNode> => {
      const found = (await readTasks(calendarId)).find((task) => task.title === title);
      if (found === undefined) throw new Error(`no task called ${title}`);
      return found;
    };

    beforeEach(async () => {
      const email = `gestures-${Date.now()}@example.test`;
      ({ calendarId } = await seed(email));

      await signIn(email, PASSWORD);
      await loadSession();

      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();

      wrapper = mounted = mount(App, { global: { plugins: [router] } });
      await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);
    });

    /** Opens the actions panel for the task placed on Tuesday. */
    const openTuesdayTask = async (): Promise<void> => {
      await wrapper
        .findAll('[data-testid="day-column"]')[1]!
        .find('[data-testid="block-task"]')
        .trigger('click');
      await settle();
    };

    it('nudges a block with the keyboard and persists the drop', async () => {
      // §14 requires a keyboard equivalent for every drag gesture. Two nudges
      // down is half an hour, at the same 15-minute step the pointer snaps to.
      const block = wrapper
        .findAll('[data-testid="day-column"]')[1]!
        .find('[data-testid="block-task"]');
      expect(block.attributes('data-start-min')).toBe('540');

      await block.trigger('keydown', { key: 'ArrowDown' });
      await block.trigger('keydown', { key: 'ArrowDown' });

      // Moved on screen before anything was sent: the drag is one intent, and
      // only the drop commits it.
      expect(block.attributes('data-start-min')).toBe('570');
      expect((await taskNamed('Tuesday work')).manualFloor).toBe('2026-03-24T08:00:00.000Z');

      await block.trigger('keydown', { key: 'Enter' });
      await settle();

      // Two nudges is half an hour: 09:30 Berlin on 2026-03-24, which is
      // 08:30Z. The floor moved with the block, because a reposition is a
      // constraint rather than a pin (§7.3).
      expect((await taskNamed('Tuesday work')).manualFloor).toBe('2026-03-24T08:30:00.000Z');
    });

    it('abandons a nudge on Escape without sending anything', async () => {
      const block = wrapper
        .findAll('[data-testid="day-column"]')[1]!
        .find('[data-testid="block-task"]');

      await block.trigger('keydown', { key: 'ArrowDown' });
      expect(block.attributes('data-start-min')).toBe('555');

      await block.trigger('keydown', { key: 'Escape' });
      await settle();

      expect(block.attributes('data-start-min')).toBe('540');
      expect((await taskNamed('Tuesday work')).manualFloor).toBe('2026-03-24T08:00:00.000Z');
    });

    it('shows the floor a reposition left, and clears it on request', async () => {
      await openTuesdayTask();

      // The seed moved this task, so it already carries a floor. A task at
      // 09:00 looks identical whether it chose to be or was told to be.
      expect(wrapper.find('[data-testid="floor-badge"]').text()).toContain('Not before');

      await wrapper.find('[data-testid="clear-floor"]').trigger('click');
      await settle();

      // §7.3's "explicit user reset" — the one of its three clearing paths
      // that had no command until M12.
      const cleared = await taskNamed('Tuesday work');
      expect(cleared.manualFloor).toBeNull();
      expect(cleared.manualBias).toBeNull();
    });

    it('moves to an exact minute the grid could not snap to', async () => {
      await openTuesdayTask();

      // §13: the grid snaps to 15 minutes, the text field takes any minute.
      await wrapper.find('[data-testid="exact-start"]').setValue('2026-03-24T14:07');
      await wrapper.find('[data-testid="move-exact"]').trigger('click');
      await settle();

      expect((await taskNamed('Tuesday work')).manualFloor).toBe('2026-03-24T13:07:00.000Z');
    });

    it('defers to the start of tomorrow', async () => {
      await openTuesdayTask();

      await wrapper.find('[data-testid="defer-tomorrow"]').trigger('click');
      await settle();

      // "Tomorrow" is measured from `now` — Monday 09:00 Berlin — so the floor
      // lands at Tuesday 00:00 Berlin, which is 2026-03-23T23:00Z.
      //
      // Note this task was *already* placed on Tuesday, so the defer relaxes
      // its floor rather than pushing it. Whether `tomorrow` should mean "the
      // day after now" or "the day after wherever this task currently sits" is
      // a question §7.3 does not settle; the handler has meant the former since
      // M6 and this pins that rather than quietly changing it.
      expect((await taskNamed('Tuesday work')).manualFloor).toBe('2026-03-23T23:00:00.000Z');
    });

    it('extends a task that is taking longer', async () => {
      await openTuesdayTask();

      await wrapper.find('[data-testid="new-estimate"]').setValue('90');
      await wrapper.find('[data-testid="extend-task"]').trigger('click');
      await settle();

      expect((await taskNamed('Tuesday work')).estimatedDurationMin).toBe(90);
    });

    it('completes a task from the editor', async () => {
      await openTuesdayTask();

      await wrapper.find('[data-testid="complete-task"]').trigger('click');
      await settle();

      const done = await taskNamed('Tuesday work');
      expect(done.status).toBe('completed');
      // §7.3: completion clears the floor, so the slot and its cooldown are
      // free for whatever the re-derive wants to put there.
      expect(done.manualFloor).toBeNull();
    });

    it('postpones the rest of a day from its column', async () => {
      await wrapper.findAll('[data-testid="postpone-day"]')[1]!.trigger('click');
      await settle();

      // Tuesday's task is pushed out of Tuesday; the appointment on Monday is
      // untouched, because §7.2 leaves those to a person.
      const columns = wrapper.findAll('[data-testid="day-column"]');
      expect(columns[1]!.find('[data-testid="block-task"]').exists()).toBe(false);
      expect(columns[0]!.find('[data-testid="block-appointment"]').exists()).toBe(true);
    });

    it('undoes the last thing done, from the UI', async () => {
      await openTuesdayTask();
      await wrapper.find('[data-testid="clear-floor"]').trigger('click');
      await settle();
      expect((await taskNamed('Tuesday work')).manualFloor).toBeNull();

      // The button names what it would reverse rather than making the user
      // remember.
      const undo = wrapper.find('[data-testid="undo"]');
      expect(undo.attributes('disabled')).toBeUndefined();
      expect(undo.attributes('title')).toBe('Undo: Clear floor');

      await undo.trigger('click');
      await settle();

      expect((await taskNamed('Tuesday work')).manualFloor).toBe('2026-03-24T08:00:00.000Z');

      // And redo puts it back, because undo is itself a command in the log.
      await wrapper.find('[data-testid="redo"]').trigger('click');
      await settle();
      expect((await taskNamed('Tuesday work')).manualFloor).toBeNull();
    });
  });

  /**
   * Plan M12b: the schedule moves before the server has answered.
   *
   * What makes this worth testing through the whole client rather than as a
   * unit is the *timing*. The command is held open, so the only thing that
   * could have moved the block is the client's own solve — and when the server
   * finally replies, the block has to stay where the preview put it.
   */
  describe('optimistic compute', () => {
    it('redraws before the command resolves, and agrees when it lands', async () => {
      const email = `optimistic-${Date.now()}@example.test`;
      await seed(email);

      await signIn(email, PASSWORD);
      await loadSession();

      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();

      const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
      await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);

      const tuesdayTask = () =>
        wrapper.findAll('[data-testid="day-column"]')[1]!.find('[data-testid="block-task"]');
      expect(tuesdayTask().attributes('data-start-min')).toBe('540');

      // Hold the command open. Anything that moves the block from here until it
      // is released came from the client's own solve.
      let release: (() => void) | undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });

      await tuesdayTask().trigger('keydown', { key: 'ArrowDown' });
      await tuesdayTask().trigger('keydown', { key: 'ArrowDown' });
      await tuesdayTask().trigger('keydown', { key: 'Enter' });
      await flushPromises();
      await flushPromises();

      // 09:30 Berlin, drawn while the POST is still in flight.
      expect(tuesdayTask().attributes('data-start-min')).toBe('570');

      release!();
      held = null;
      await settle();

      // And the server agreed, so nothing moved a second time and no divergence
      // was reported.
      expect(tuesdayTask().attributes('data-start-min')).toBe('570');
      expect(wrapper.find('[data-testid="schedule-diverged"]').exists()).toBe(false);
    });
  });

  /**
   * Plan M13: the engine's signals, on screen.
   *
   * The distinction §6.5 and §6.7 draw — soft warns, hard alerts — has to
   * survive all the way to the markup, because a centre that showed both the
   * same way would throw away the care the engine took to tell them apart.
   */
  describe('signals', () => {
    const openCalendar = async (email: string) => {
      await signIn(email, PASSWORD);
      await loadSession();

      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();

      const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
      await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);
      return wrapper;
    };

    it('shows a hard-due alert above a soft-due warning, and dismisses them', async () => {
      const email = `signals-${Date.now()}@example.test`;
      const { calendarId, categoryId, command } = await seed(email);

      // Neither can finish by 09:30 Berlin from a 09:00 start, so both are at
      // risk in exactly the same way and only `due_kind` differs.
      for (const kind of ['soft', 'hard'] as const) {
        await command({
          type: 'CreateTask',
          params: {
            calendarId,
            title: `${kind} deadline`,
            categoryId,
            estimatedDurationMin: 60,
            dueDate: { date: '2026-03-23T08:30:00Z', kind },
          },
        });
      }

      const wrapper = await openCalendar(email);
      await waitFor(() => wrapper.findAll('[data-testid="notification"]').length >= 2);

      const severities = wrapper
        .findAll('[data-testid="notification"]')
        .map((row) => row.attributes('data-severity'));

      // Alerts first: they are the ones that demand attention now.
      expect(severities[0]).toBe('alert');
      expect(severities).toContain('warning');
      expect(wrapper.find('[data-testid="alert-count"]').text()).toContain('1');

      await wrapper.find('[data-testid="dismiss-all"]').trigger('click');
      await settle();

      expect(wrapper.find('[data-testid="no-signals"]').exists()).toBe(true);
    });

    it('shows the per-category utilization indicator (§6.6)', async () => {
      const email = `capacity-${Date.now()}@example.test`;
      const { calendarId, categoryId, command } = await seed(email);

      // Far more than one week of the category's windows can hold, and all of
      // it *due* that week — which is what makes the week overcommitted rather
      // than merely full. Demand counts the week a task is due as well as the
      // week it landed in (§6.6), so work pushed out still counts against the
      // week that could not absorb it; otherwise utilization would fall back to
      // 1.0 the moment a week overflowed and the signal could never fire.
      for (let index = 0; index < 12; index += 1) {
        await command({
          type: 'CreateTask',
          params: {
            calendarId,
            title: `Bulk ${index}`,
            categoryId,
            estimatedDurationMin: 480,
            dueDate: { date: '2026-03-27T16:00:00Z', kind: 'soft' },
          },
        });
      }

      const wrapper = await openCalendar(email);
      await waitFor(() => wrapper.findAll('[data-testid="capacity-cell"]').length > 0);

      const cells = wrapper.findAll('[data-testid="capacity-cell"]');
      expect(cells.some((cell) => cell.attributes('data-status') === 'overcommitted')).toBe(true);

      // §6.6 wants the *indicator* as well as the backlog notification, and the
      // backlog notification is informational rather than an alert.
      const backlog = wrapper
        .findAll('[data-testid="notification"]')
        .filter((row) => row.attributes('data-type') === 'backlog_added');
      expect(backlog.length).toBeGreaterThan(0);
      expect(backlog.every((row) => row.attributes('data-severity') === 'info')).toBe(true);
    });

    it('surfaces the chronic-postponement signal (§6.6)', async () => {
      const email = `chronic-${Date.now()}@example.test`;
      const { calendarId, categoryId, command } = await seed(email);

      const created = (await command({
        type: 'CreateTask',
        params: { calendarId, title: 'Keeps slipping', categoryId, estimatedDurationMin: 60 },
      })) as CommandBody;
      const taskId = created.created.find((row) => row.entity === 'task')!.id;

      for (let index = 0; index < 5; index += 1) {
        await command({ type: 'DeferTask', params: { taskId, target: 'tomorrow' } });
      }

      const wrapper = await openCalendar(email);
      await waitFor(() =>
        wrapper
          .findAll('[data-testid="notification"]')
          .some((row) => row.attributes('data-type') === 'chronic_postponement'),
      );

      const chronic = wrapper
        .findAll('[data-testid="notification"]')
        .find((row) => row.attributes('data-type') === 'chronic_postponement')!;
      expect(chronic.text()).toContain('Keeps slipping');
    });
  });

  /**
   * Plan M14b: a recurring appointment, and §8.1's two edit scopes.
   *
   * The grid draws instances rather than rules, so an expanded occurrence has
   * no row and no id — which is why the editor has to name one by its start,
   * and why this is worth walking through the real client rather than asserting
   * on the API alone.
   */
  describe('recurring appointments', () => {
    it('draws every instance, and edits just one of them', async () => {
      const email = `rrule-${Date.now()}@example.test`;
      const { calendarId, command } = await seed(email);

      await command({
        type: 'AddAppointment',
        params: {
          calendarId,
          title: 'Weekly sync',
          start: '2026-03-24T13:00:00Z',
          end: '2026-03-24T14:00:00Z',
          recurrence: { rule: 'FREQ=WEEKLY;BYDAY=TU', timeZone: 'Europe/Berlin' },
        },
      });

      await signIn(email, PASSWORD);
      await loadSession();

      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();

      const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
      await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);

      // One row, drawn on the Tuesday of the week being shown.
      const tuesday = (title: string) =>
        wrapper
          .findAll('[data-testid="day-column"]')[1]!
          .findAll('[data-testid="block-appointment"]')
          .find((block) => block.attributes('data-title') === title);
      expect(tuesday('Weekly sync')).toBeDefined();

      await tuesday('Weekly sync')!.trigger('click');
      await flushPromises();

      // Editing an instance must ask which occurrences it applies to, and
      // default to the one that changes least.
      expect(wrapper.find('[data-testid="scope-fieldset"]').exists()).toBe(true);
      expect(
        (wrapper.find('[data-testid="scope-occurrence"]').element as HTMLInputElement).checked,
      ).toBe(true);

      await wrapper.find('[data-testid="appointment-title"]').setValue('Weekly sync (moved)');
      await wrapper.find('[data-testid="save-appointment"]').trigger('click');
      await settle();

      expect(tuesday('Weekly sync (moved)')).toBeDefined();
      expect(tuesday('Weekly sync')).toBeUndefined();

      // …and next week is untouched, which is the whole promise of the choice.
      await wrapper.find('[data-testid="week-forward"]').trigger('click');
      await settle();

      const nextWeek = wrapper
        .findAll('[data-testid="day-column"]')[1]!
        .findAll('[data-testid="block-appointment"]')
        .map((block) => block.attributes('data-title'));
      expect(nextWeek).toContain('Weekly sync');
      expect(nextWeek).not.toContain('Weekly sync (moved)');
    });

    it('offers repetition when creating, and expands what it creates', async () => {
      const email = `rrule-create-${Date.now()}@example.test`;
      await seed(email);

      await signIn(email, PASSWORD);
      await loadSession();

      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();

      const wrapper = (mounted = mount(App, { global: { plugins: [router] } }));
      await waitFor(() => wrapper.findAll('[data-testid="day-column"]').length === 7);

      await wrapper.findAll('[data-testid="add-block"]')[2]!.trigger('click');
      await flushPromises();

      await wrapper.find('[data-testid="appointment-title"]').setValue('Retro');
      await wrapper.find('[data-testid="appointment-repeats"]').setValue(true);
      await flushPromises();
      await wrapper.find('[data-testid="appointment-frequency"]').setValue('WEEKLY');
      await wrapper.find('[data-testid="save-appointment"]').trigger('click');
      await settle();

      // This week's Wednesday…
      expect(
        wrapper
          .findAll('[data-testid="day-column"]')[2]!
          .findAll('[data-testid="block-appointment"]')
          .some((block) => block.attributes('data-title') === 'Retro'),
      ).toBe(true);

      // …and next week's, from the one row that was written.
      await wrapper.find('[data-testid="week-forward"]').trigger('click');
      await settle();
      expect(
        wrapper
          .findAll('[data-testid="day-column"]')[2]!
          .findAll('[data-testid="block-appointment"]')
          .some((block) => block.attributes('data-title') === 'Retro'),
      ).toBe(true);
    });
  });
});

/** The task list as the server reports it, for assertions the DOM cannot make. */
async function readTasks(calendarId: string): Promise<TaskNode[]> {
  const response = await fetch(`/api/calendars/${calendarId}/tasks`);
  const body = (await response.json()) as { tasks: TaskNode[] };
  return body.tasks;
}

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

  return { cookie, calendarId, categoryId, command };
}

interface Seeded {
  cookie: string;
  calendarId: string;
  categoryId: string;
  /** Issues further commands as the seeded user, before the client signs in. */
  command: (body: unknown) => Promise<CommandBody>;
}

interface CommandBody {
  created: { entity: string; id: string }[];
  schedules: { blocks: { taskId: string; title: string }[] }[];
}
