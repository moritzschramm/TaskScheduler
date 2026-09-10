import { mount } from '@vue/test-utils';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import TaskListPanel from '@/components/panels/TaskListPanel.vue';
import type { TaskNode } from '@ambitime/shared';

/**
 * The tree side of spec §4.4: depth, nesting, and the hard cap of five.
 *
 * The rows arrive in depth-first order with a materialised path, so what is
 * tested here is that the panel *uses* that rather than rebuilding it — and
 * that the cap is visible as a disabled affordance rather than as a refusal
 * after the fact.
 */
function node(id: string, depth: number, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    parentId: null,
    title: `Task ${id}`,
    notes: null,
    depth,
    path: [id],
    isLeaf: true,
    status: 'active',
    version: 1,
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
    manualFloor: null,
    manualBias: null,
    recurrence: null,
    ...overrides,
  };
}

/**
 * Five tasks, each the child of the one above it.
 *
 * The parent links are the point rather than decoration: indentation is now
 * counted as ancestors *within the same group*, so that an activity type
 * overridden on a subtask puts it at the left edge of the group it moved to
 * rather than three levels in under nothing.
 */
const ladder = [1, 2, 3, 4, 5].map((depth) =>
  node(`t${depth}`, depth, depth === 1 ? {} : { parentId: `t${depth - 1}` }),
);

function panel(tasks: TaskNode[], editable = true) {
  return mount(TaskListPanel, { props: { tasks, editable } });
}

describe('the task tree', () => {
  it('indents each level, and keeps the order it was given', () => {
    const rows = panel(ladder).findAll('[data-testid="task-row"]');

    expect(rows.map((row) => row.attributes('data-depth'))).toEqual(['1', '2', '3', '4', '5']);
    // Indentation is a left margin, counted from the ancestors that share the
    // row's group; parents already precede their children in the query's own
    // ordering, so nothing is rebuilt here.
    const indents = rows.map((row) => row.find('td span').attributes('style')?.replace(/\s/g, ''));
    expect(indents).toEqual([
      'padding-left:0px;',
      'padding-left:16px;',
      'padding-left:32px;',
      'padding-left:48px;',
      'padding-left:64px;',
    ]);
  });

  it('refuses a sixth level, visibly', () => {
    const rows = panel(ladder).findAll('[data-testid="task-row"]');
    const buttons = rows.map((row) => row.find('[data-testid="add-subtask"]'));

    // Disabled rather than absent: an affordance that vanishes teaches nothing,
    // and the cap of five is a rule worth stating (§4.4).
    expect(buttons.slice(0, 4).every((button) => button.attributes('disabled') === undefined)).toBe(
      true,
    );
    expect(buttons[4]!.attributes('disabled')).toBeDefined();
    expect(buttons[4]!.attributes('title')).toContain('five deep');
  });

  it('does not offer subtasks of a task that is no longer active', () => {
    const rows = panel([node('t1', 1, { status: 'cancelled' })]).findAll(
      '[data-testid="task-row"]',
    );

    expect(rows[0]!.find('[data-testid="add-subtask"]').attributes('disabled')).toBeDefined();
  });

  it('emits the task a row names when it is picked', async () => {
    const wrapper = panel(ladder);

    await wrapper.findAll('[data-testid="select-task"]')[2]!.trigger('click');

    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ id: 't3' });
  });

  it('emits the parent a subtask would hang from', async () => {
    const wrapper = panel(ladder);

    await wrapper.findAll('[data-testid="add-subtask"]')[1]!.trigger('click');

    expect(wrapper.emitted('addChild')?.[0]?.[0]).toMatchObject({ id: 't2' });
  });

  it('marks the selected row', () => {
    const rows = mount(TaskListPanel, {
      props: { tasks: ladder, editable: true, selectedId: 't4' },
    }).findAll('[data-testid="task-row"]');

    expect(rows.map((row) => row.attributes('data-selected'))).toEqual([
      'false',
      'false',
      'false',
      'true',
      'false',
    ]);
  });

  it('stays read-only when it is not editable', () => {
    const wrapper = panel(ladder, false);

    // M10's panel, unchanged: no way to select, add or nest.
    expect(wrapper.find('[data-testid="select-task"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="add-subtask"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="add-root-task"]').exists()).toBe(false);
  });

  it('distinguishes an inherited value from an owned one', () => {
    const rows = panel([
      node('own', 1, { ownPriority: 3, effectivePriority: 3 }),
      node('inherited', 2, { ownPriority: null, effectivePriority: 3 }),
    ]).findAll('[data-testid="task-row"]');

    // Title, estimate, priority, due, actions — the third cell is priority.
    const priorityCell = (index: number) => rows[index]!.findAll('td')[2]!.find('span');

    expect(priorityCell(0).classes()).not.toContain('italic');
    expect(priorityCell(1).classes()).toContain('italic');
  });
});

describe('the quick-add row', () => {
  const work = { id: 'cat-work', name: 'Work', defaultCooldownMin: 0, color: null, version: 1 };

  function panelWith(quickAdd: (draft: unknown) => Promise<boolean>) {
    return mount(TaskListPanel, {
      props: {
        tasks: [node('t1', 1, { effectiveCategoryId: 'cat-work' })],
        categories: [work],
        editable: true,
        quickAdd,
      },
    });
  }

  it('creates a task in the group it sits in', async () => {
    const quickAdd = vi.fn().mockResolvedValue(true);
    const wrapper = panelWith(quickAdd);

    await wrapper.find('[data-testid="quick-add-title"]').setValue('Invoices');
    await wrapper.find('[data-testid="quick-add-estimate"]').setValue('30');
    await wrapper.find('[data-testid="quick-add-due"]').setValue('2026-04-02');
    await wrapper.find('[data-testid="quick-add-save"]').trigger('click');

    // The group is the activity type, so the row never has to ask for it —
    // which is the field §6.2 rule 1 makes mandatory.
    expect(quickAdd).toHaveBeenCalledWith({
      categoryId: 'cat-work',
      title: 'Invoices',
      estimatedDurationMin: 30,
      priority: null,
      dueDate: '2026-04-02',
    });
  });

  it('reads a priority typed into a number field', async () => {
    // `v-model` on a `type="number"` input hands back a number, not a string —
    // which a draft that assumed strings met as `.trim is not a function`,
    // silently, on the one field none of these tests used to fill in.
    const quickAdd = vi.fn().mockResolvedValue(true);
    const wrapper = panelWith(quickAdd);

    await wrapper.find('[data-testid="quick-add-title"]').setValue('Invoices');
    await wrapper.find('[data-testid="quick-add-estimate"]').setValue('30');
    await wrapper.find('[data-testid="quick-add-priority"]').setValue('2');
    await wrapper.find('[data-testid="quick-add-save"]').trigger('click');

    expect(quickAdd).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 2, estimatedDurationMin: 30 }),
    );
  });

  it('will not send without a title and an estimate', async () => {
    const quickAdd = vi.fn().mockResolvedValue(true);
    const wrapper = panelWith(quickAdd);
    const save = () => wrapper.find('[data-testid="quick-add-save"]');

    expect(save().attributes('disabled')).toBeDefined();

    await wrapper.find('[data-testid="quick-add-title"]').setValue('Invoices');
    // A task with no estimate cannot be placed, so a quick way to make one
    // would be a quick way to fill the "could not be scheduled" list.
    expect(save().attributes('disabled')).toBeDefined();

    await wrapper.find('[data-testid="quick-add-estimate"]').setValue('30');
    expect(save().attributes('disabled')).toBeUndefined();
  });

  it('empties itself once the task has landed, and not before', async () => {
    const quickAdd = vi.fn().mockResolvedValue(false);
    const wrapper = panelWith(quickAdd);

    await wrapper.find('[data-testid="quick-add-title"]').setValue('Invoices');
    await wrapper.find('[data-testid="quick-add-estimate"]').setValue('30');
    await wrapper.find('[data-testid="quick-add-save"]').trigger('click');
    await flushPromises();

    // Refused: the words stay, because that is the only state the user can try
    // again from without retyping.
    const title = () => wrapper.find('[data-testid="quick-add-title"]').element as HTMLInputElement;
    expect(title().value).toBe('Invoices');

    quickAdd.mockResolvedValue(true);
    await wrapper.find('[data-testid="quick-add-save"]').trigger('click');
    await flushPromises();

    expect(title().value).toBe('');
  });

  it('sends on Enter from any of its fields', async () => {
    const quickAdd = vi.fn().mockResolvedValue(true);
    const wrapper = panelWith(quickAdd);

    await wrapper.find('[data-testid="quick-add-title"]').setValue('Invoices');
    await wrapper.find('[data-testid="quick-add-estimate"]').setValue('30');
    await wrapper.find('[data-testid="quick-add-estimate"]').trigger('keydown.enter');

    expect(quickAdd).toHaveBeenCalledTimes(1);
  });

  it('is absent from a panel with no way to create one', () => {
    const readOnly = mount(TaskListPanel, { props: { tasks: [node('t1', 1)], editable: false } });

    expect(readOnly.find('[data-testid="quick-add"]').exists()).toBe(false);
  });
});

describe('a task that is no longer outstanding', () => {
  it('is struck through, where the status column used to say so', () => {
    const rows = panel([
      node('done', 1, { status: 'completed' }),
      node('live', 1, { status: 'active' }),
    ]).findAll('[data-testid="task-row"]');

    expect(rows[0]!.find('[data-testid="select-task"]').classes()).toContain('line-through');
    expect(rows[1]!.find('[data-testid="select-task"]').classes()).not.toContain('line-through');
  });

  it('has no status column to say it in', () => {
    const headers = panel([node('t1', 1)])
      .findAll('th')
      .map((cell) => cell.text());

    expect(headers).not.toContain('Status');
  });
});
