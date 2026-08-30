import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import TaskEditor from '@/components/tasks/TaskEditor.vue';
import type { Category, CommandRequest, TaskNode } from '@ambitime/shared';

/**
 * Spec §4.4's inheritance, as a form.
 *
 * What is asserted is the **command that comes out**, not the markup. The rule
 * that matters is the three-state one — set here, inherited, unset — and the
 * only way to tell those apart from outside is whether the patch carries a
 * value, a `null`, or nothing at all.
 */

const CATEGORIES: Category[] = [
  { id: '018f0000-0000-7000-8000-0000000000c1', name: 'Work', defaultCooldownMin: 0, version: 1 },
  {
    id: '018f0000-0000-7000-8000-0000000000c2',
    name: 'Exercise',
    defaultCooldownMin: 15,
    version: 1,
  },
];

function task(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    parentId: null,
    title: 'Write the report',
    notes: null,
    depth: 1,
    path: ['018f0000-0000-7000-8000-000000000001'],
    isLeaf: true,
    status: 'active',
    version: 3,
    estimatedDurationMin: 60,
    ownCategoryId: null,
    effectiveCategoryId: null,
    ownPriority: null,
    effectivePriority: null,
    ownDueDate: null,
    effectiveDueDate: null,
    ownDueKind: null,
    effectiveDueKind: null,
    ownPreferredStartMin: null,
    effectivePreferredStartMin: null,
    ownPreferredEndMin: null,
    effectivePreferredEndMin: null,
    ownFocusLevel: null,
    effectiveFocusLevel: null,
    ownCooldownOverrideMin: null,
    effectiveCooldownOverrideMin: null,
    ...overrides,
  };
}

function editor(props: { task: TaskNode | null; parent?: TaskNode | null }) {
  const submit = vi.fn<(request: CommandRequest) => Promise<boolean>>().mockResolvedValue(true);

  const wrapper = mount(TaskEditor, {
    props: {
      task: props.task,
      parent: props.parent ?? null,
      calendarId: '018f0000-0000-7000-8000-0000000000ca',
      categories: CATEGORIES,
      timeZone: 'Europe/Berlin',
      submit,
    },
  });

  return { wrapper, submit };
}

/** The patch of the last `EditTask` the form sent. */
function patchOf(submit: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const request = submit.mock.calls.at(-1)?.[0] as { params: { patch: Record<string, unknown> } };
  return request.params.patch;
}

describe('the task editor', () => {
  it('shows an inherited property as inherited, not as its own', () => {
    const child = task({
      depth: 2,
      ownPriority: null,
      effectivePriority: 7,
      ownCategoryId: null,
      effectiveCategoryId: CATEGORIES[0]!.id,
    });

    const { wrapper } = editor({ task: child });
    const priority = wrapper.find('[data-testid="field-priority"]');

    // No value control at all while inheriting: editing the box *is* what
    // overriding means, so offering one that does not override would be a lie.
    expect(priority.find('[data-testid="task-priority"]').exists()).toBe(false);
    expect(priority.find('[data-testid="inherited-value"]').text()).toContain('7');

    // The category resolves to a name rather than showing a raw id.
    expect(
      wrapper.find('[data-testid="field-category"] [data-testid="inherited-value"]').text(),
    ).toContain('Work');
  });

  it('says so when nothing supplies a value', () => {
    const { wrapper } = editor({ task: task() });

    expect(
      wrapper.find('[data-testid="field-priority"] [data-testid="inherited-value"]').text(),
    ).toBe('Not set');
  });

  it('sends a value when a property is overridden', async () => {
    const child = task({ depth: 2, effectivePriority: 7 });
    const { wrapper, submit } = editor({ task: child });

    await wrapper
      .find('[data-testid="field-priority"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="task-priority"]').setValue('2');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    expect(patchOf(submit)['priority']).toBe(2);
  });

  it('sends null when an override is cleared, which is what reverts it', async () => {
    // The half of §4.4 a plain form cannot express: once overridden, there
    // would be no way back to inheriting, because "empty" and "inherit" would
    // look the same.
    const overridden = task({ depth: 2, ownPriority: 2, effectivePriority: 2 });
    const { wrapper, submit } = editor({ task: overridden });

    expect(wrapper.find('[data-testid="task-priority"]').exists()).toBe(true);

    await wrapper
      .find('[data-testid="field-priority"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    expect(patchOf(submit)['priority']).toBeNull();
  });

  it('carries the version it read, so a stale editor is refused', async () => {
    const { wrapper, submit } = editor({ task: task({ version: 9 }) });

    await wrapper.find('[data-testid="save-task"]').trigger('click');

    expect(submit.mock.calls.at(-1)?.[0]).toMatchObject({ expectedVersion: 9 });
  });

  it('refuses a due date later than its container, before sending anything', async () => {
    const parent = task({
      id: '018f0000-0000-7000-8000-0000000000aa',
      ownDueDate: '2026-03-27T16:00:00.000Z',
      effectiveDueDate: '2026-03-27T16:00:00.000Z',
    });
    const child = task({
      id: '018f0000-0000-7000-8000-0000000000bb',
      depth: 2,
      parentId: parent.id,
    });

    const { wrapper, submit } = editor({ task: child, parent });

    await wrapper
      .find('[data-testid="field-due"] [data-testid="override-toggle"]')
      .trigger('click');
    await wrapper.find('[data-testid="task-due"]').setValue('2026-04-03T17:00');

    // §4.4's rule. The database enforces it with a deferred trigger and the API
    // turns that into a sentence, but a form that lets you type a date, press
    // save and *then* explains has wasted the typing.
    expect(wrapper.find('[data-testid="due-conflict"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-task"]').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-testid="save-task"]').trigger('click');
    expect(submit).not.toHaveBeenCalled();
  });

  it('accepts a due date exactly equal to its container’s', async () => {
    const parent = task({
      id: '018f0000-0000-7000-8000-0000000000aa',
      ownDueDate: '2026-03-27T16:00:00.000Z',
      effectiveDueDate: '2026-03-27T16:00:00.000Z',
    });
    const child = task({
      id: '018f0000-0000-7000-8000-0000000000bb',
      depth: 2,
      parentId: parent.id,
    });

    const { wrapper, submit } = editor({ task: child, parent });

    await wrapper
      .find('[data-testid="field-due"] [data-testid="override-toggle"]')
      .trigger('click');
    // 16:00Z is 17:00 Berlin in March — the same instant, written the way the
    // field writes it. The rule is ≤, not <.
    await wrapper.find('[data-testid="task-due"]').setValue('2026-03-27T17:00');

    expect(wrapper.find('[data-testid="due-conflict"]').exists()).toBe(false);

    await wrapper.find('[data-testid="save-task"]').trigger('click');
    expect(patchOf(submit)['dueDate']).toEqual({
      date: '2026-03-27T16:00:00.000Z',
      kind: 'soft',
    });
  });

  it('creates under a parent, and omits what was never set', async () => {
    const parent = task({ effectivePriority: 4 });
    const { wrapper, submit } = editor({ task: null, parent });

    await wrapper.find('[data-testid="task-title"]').setValue('Draft the outline');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    // A create takes no nulls: an absent property simply is not set, and there
    // is no prior override to clear.
    const request = submit.mock.calls.at(-1)?.[0] as {
      type: string;
      params: Record<string, unknown>;
    };
    expect(request.type).toBe('CreateTask');
    expect(request.params['parentId']).toBe(parent.id);
    expect(request.params).not.toHaveProperty('priority');
    expect(request.params).not.toHaveProperty('dueDate');
  });

  it('offers complete and cancel only for a task that exists and is active', () => {
    expect(editor({ task: null }).wrapper.find('[data-testid="complete-task"]').exists()).toBe(
      false,
    );
    expect(
      editor({ task: task({ status: 'completed' }) })
        .wrapper.find('[data-testid="complete-task"]')
        .exists(),
    ).toBe(false);
    expect(editor({ task: task() }).wrapper.find('[data-testid="complete-task"]').exists()).toBe(
      true,
    );
  });

  it('cancels rather than deletes', async () => {
    const { wrapper, submit } = editor({ task: task() });

    await wrapper.find('[data-testid="delete-task"]').trigger('click');

    // §7.3's vocabulary: the footprint is freed and the schedule re-derived,
    // rather than the history being made untrue.
    expect(submit.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'CancelTask' });
  });
});
