import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GettingStarted from '@/components/GettingStarted.vue';
import { resetWorkspace } from '@/lib/workspace';

/**
 * The second question a new account is asked (spec §4.4).
 *
 * The first screen stopped at "you have hours", which leaves the one other
 * structuring idea in the model — that a task with tasks under it is a project,
 * and they inherit its priority, its deadline and its preferred times — to be
 * found on a button marked "Break up", on a row nobody has written yet. This is
 * the only moment the application has anybody's attention on how their work is
 * arranged, so it asks once.
 */

/** A well-formed UUID the shared schemas will accept. */
const id = (n: number): string => `01890000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Every command the two steps sent, in order. */
let sent: { type: string; params: Record<string, unknown>; groupId?: string }[] = [];

beforeEach(() => {
  sent = [];
  resetWorkspace();

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/api/commands') && init?.method === 'POST') {
      const command = JSON.parse(String(init.body)) as (typeof sent)[number];
      sent.push(command);

      // Ids the next command in the group refers to, shaped as the API's
      // `created` list so `createdId` can read them.
      const entity =
        command.type === 'CreateCalendar'
          ? ('calendar' as const)
          : command.type === 'CreateActivityType'
            ? ('activity_type' as const)
            : ('task' as const);

      return json({
        commandId: id(sent.length),
        seq: String(sent.length),
        created: [{ entity, id: id(100 + sent.length) }],
        schedules: [],
        attention: [],
      });
    }

    return json({ calendars: [] });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetWorkspace();
});

const started = () => mount(GettingStarted);

async function firstStep(wrapper: ReturnType<typeof started>) {
  await wrapper.find('[data-testid="first-activity-type-name"]').setValue('Work');
  await wrapper.find('[data-testid="begin"]').trigger('click');
  await flushPromises();
}

describe('after the hours are set', () => {
  it('asks what the person is working on', async () => {
    const wrapper = started();
    await firstStep(wrapper);

    expect(wrapper.find('[data-testid="first-project-name"]').exists()).toBe(true);
    // And is no longer asking the first question in the same breath.
    expect(wrapper.find('[data-testid="first-activity-type-name"]').exists()).toBe(false);
  });

  it('makes the project and the first thing in it, as one group', async () => {
    const wrapper = started();
    await firstStep(wrapper);

    await wrapper.find('[data-testid="first-project-name"]').setValue('Billing revamp');
    await wrapper.find('[data-testid="first-task-title"]').setValue('Spec the plan picker');
    await wrapper.find('[data-testid="first-task-estimate"]').setValue('45');
    await wrapper.find('[data-testid="finish"]').trigger('click');
    await flushPromises();

    const tasks = sent.filter((command) => command.type === 'CreateTask');
    expect(tasks).toHaveLength(2);

    // The container carries the activity type and no estimate: only leaves are
    // placed, so minutes on it would be time that never reaches the grid.
    expect(tasks[0]!.params).toMatchObject({ title: 'Billing revamp' });
    expect(tasks[0]!.params['estimatedDurationMin']).toBeUndefined();

    // The child carries the estimate and inherits the type from above it.
    expect(tasks[1]!.params).toMatchObject({
      title: 'Spec the plan picker',
      estimatedDurationMin: 45,
    });
    expect(tasks[1]!.params['parentId']).toBe(id(100 + sent.indexOf(tasks[0]!) + 1));
    expect(tasks[1]!.params['activityTypeId']).toBeUndefined();

    // One group, so one undo takes back the project and its first task
    // together rather than leaving a container with nothing in it (§7.5).
    expect(tasks[0]!.groupId).toBe(tasks[1]!.groupId);
  });

  it('will not make a project with nothing in it', async () => {
    // A container with no children is a leaf with no estimate, which is §6.7's
    // `no_duration` — a well-meant empty project would greet a brand-new
    // account with a warning about itself.
    const wrapper = started();
    await firstStep(wrapper);

    await wrapper.find('[data-testid="first-project-name"]').setValue('Billing revamp');

    expect(wrapper.find('[data-testid="finish"]').attributes('disabled')).toBeDefined();
  });

  it('can be skipped, which is a button rather than a shrug', async () => {
    const wrapper = started();
    await firstStep(wrapper);

    const before = sent.length;
    await wrapper.find('[data-testid="skip"]').trigger('click');
    await flushPromises();

    expect(sent).toHaveLength(before);
  });
});
