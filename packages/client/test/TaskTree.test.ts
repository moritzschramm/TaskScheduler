import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
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
    ...overrides,
  };
}

const ladder = [1, 2, 3, 4, 5].map((depth) => node(`t${depth}`, depth));

function panel(tasks: TaskNode[], editable = true) {
  return mount(TaskListPanel, { props: { tasks, editable } });
}

describe('the task tree', () => {
  it('indents each level, and keeps the order it was given', () => {
    const rows = panel(ladder).findAll('[data-testid="task-row"]');

    expect(rows.map((row) => row.attributes('data-depth'))).toEqual(['1', '2', '3', '4', '5']);
    // Indentation is a left margin off `depth`, not a second data structure:
    // parents already precede their children in the query's own ordering.
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

    const priorityCell = (index: number) => rows[index]!.findAll('td')[3]!.find('span');

    expect(priorityCell(0).classes()).not.toContain('italic');
    expect(priorityCell(1).classes()).toContain('italic');
  });
});
