import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import TaskListPanel from '@/components/panels/TaskListPanel.vue';
import type { ActivityType, TaskNode } from '@ambitime/shared';

/**
 * A task with tasks under it is a project (spec §4.4).
 *
 * The model has always said so — only leaves are placed, and a container's
 * duration and completion "roll up from its leaves" — and the screen said none
 * of it. A container rendered exactly like a leaf apart from sixteen pixels of
 * indent on the rows beneath it; the Estimate column showed its own
 * `estimated_duration_min`, a number that never becomes time on the grid, in
 * the same type as the leaves' numbers that do; and the roll-up the modal
 * promised was computed nowhere.
 *
 * Three gestures follow from saying it properly: fold a project away, write a
 * task straight into one, and put tasks into one after the fact.
 */

const WORK = 'act-work';

const ACTIVITY_TYPES: ActivityType[] = [
  { id: WORK, name: 'Work', defaultCooldownMin: 0, color: 'blue', version: 1 },
];

function node(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    parentId: null,
    title: id,
    notes: null,
    depth: 1,
    path: [id],
    isLeaf: true,
    status: 'active',
    version: 1,
    estimatedDurationMin: 60,
    ownActivityTypeId: WORK,
    effectiveActivityTypeId: WORK,
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
    ownPreferredWeekdays: null,
    effectivePreferredWeekdays: null,
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

/** A project of three, one of them done, plus a loose task beside it. */
const tasks: TaskNode[] = [
  node('Billing revamp', { isLeaf: false, estimatedDurationMin: 15 }),
  node('Spec it', { parentId: 'Billing revamp', depth: 2, ownActivityTypeId: null }),
  node('Migrate rows', {
    parentId: 'Billing revamp',
    depth: 2,
    ownActivityTypeId: null,
    estimatedDurationMin: 90,
    status: 'completed',
  }),
  node('Changelog', { parentId: 'Billing revamp', depth: 2, ownActivityTypeId: null }),
  node('Answer support', {}),
];

function panel(overrides: { tasks?: TaskNode[]; quickAdd?: unknown } = {}) {
  return mount(TaskListPanel, {
    props: {
      tasks: overrides.tasks ?? tasks,
      activityTypes: ACTIVITY_TYPES,
      editable: true,
      quickAdd: overrides.quickAdd ?? (() => Promise.resolve(true)),
    } as never,
  });
}

const titles = (wrapper: ReturnType<typeof panel>) =>
  wrapper.findAll('[data-testid="task-row"]').map((row) => row.attributes('data-task-id'));

const rowFor = (wrapper: ReturnType<typeof panel>, id: string) =>
  wrapper.get(`[data-testid="task-row"][data-task-id="${id}"]`);

describe('a container reads as one', () => {
  it('shows what the work inside it adds up to, not its own number', () => {
    // 60 + 90 + 60 from the leaves. Its own 15 is never scheduled, so showing
    // it in the same column as the leaves' minutes was a number that looked
    // like time and was not.
    const wrapper = panel();

    expect(rowFor(wrapper, 'Billing revamp').get('[data-testid="rolled-up-estimate"]').text()).toBe(
      '210',
    );
    expect(
      rowFor(wrapper, 'Answer support').find('[data-testid="rolled-up-estimate"]').exists(),
    ).toBe(false);
  });

  it('says how far through it somebody is', () => {
    const wrapper = panel();

    expect(rowFor(wrapper, 'Billing revamp').get('[data-testid="project-progress"]').text()).toBe(
      '1/3 done',
    );
  });

  it('counts neither the estimate nor the progress of a cancelled task', () => {
    // Pruning a project must not make it look further from done than before.
    const wrapper = panel({
      tasks: tasks.map((task) =>
        task.id === 'Changelog' ? { ...task, status: 'cancelled' as const } : task,
      ),
    });

    const row = rowFor(wrapper, 'Billing revamp');
    expect(row.get('[data-testid="rolled-up-estimate"]').text()).toBe('150');
    expect(row.get('[data-testid="project-progress"]').text()).toBe('1/2 done');
  });

  it('offers no progress on a leaf, which is not a project', () => {
    const wrapper = panel();

    expect(
      rowFor(wrapper, 'Answer support').find('[data-testid="project-progress"]').exists(),
    ).toBe(false);
  });

  it('folds away, and brings its subtree with it', async () => {
    const wrapper = panel();
    expect(titles(wrapper)).toHaveLength(5);

    await rowFor(wrapper, 'Billing revamp').get('[data-testid="fold-task"]').trigger('click');

    expect(titles(wrapper)).toEqual(['Billing revamp', 'Answer support']);
  });

  it('offers no fold on a leaf', () => {
    const wrapper = panel();

    expect(rowFor(wrapper, 'Answer support').find('[data-testid="fold-task"]').exists()).toBe(
      false,
    );
  });
});

describe('writing a task straight into a project', () => {
  it('puts an empty row at the foot of an open one', () => {
    const wrapper = panel();
    const parents = wrapper
      .findAll('[data-testid="quick-add"]')
      .map((row) => row.attributes('data-parent'));

    // One inside the project, one at the foot of the group for a root task.
    expect(parents).toEqual(['Billing revamp', '']);
  });

  it('takes it away again when the project is folded', async () => {
    const wrapper = panel();
    await rowFor(wrapper, 'Billing revamp').get('[data-testid="fold-task"]').trigger('click');

    const parents = wrapper
      .findAll('[data-testid="quick-add"]')
      .map((row) => row.attributes('data-parent'));
    expect(parents).toEqual(['']);
  });

  it('names the parent and lets the activity type be inherited', async () => {
    // Sending the group's type as well would write an override identical to
    // what would be inherited, which is an override that looks like it does
    // nothing when you later clear it (§4.4).
    const quickAdd = vi.fn().mockResolvedValue(true);
    const wrapper = panel({ quickAdd });

    const row = wrapper.get('[data-testid="quick-add"][data-parent="Billing revamp"]');
    await row.get('[data-testid="quick-add-title"]').setValue('Write the migration');
    await row.get('[data-testid="quick-add-estimate"]').setValue('45');
    await row.get('[data-testid="quick-add-save"]').trigger('click');
    await flushPromises();

    expect(quickAdd).toHaveBeenCalledWith({
      activityTypeId: null,
      parentId: 'Billing revamp',
      title: 'Write the migration',
      estimatedDurationMin: 45,
      priority: null,
      dueDate: null,
    });
  });
});

describe('grouping work that was written down flat', () => {
  const choose = async (wrapper: ReturnType<typeof panel>, id: string) => {
    await rowFor(wrapper, id).get('[data-testid="choose-task"]').setValue(true);
  };

  it('shows nothing until something is ticked', async () => {
    const wrapper = panel();
    expect(wrapper.find('[data-testid="chosen-bar"]').exists()).toBe(false);

    await choose(wrapper, 'Answer support');

    expect(wrapper.get('[data-testid="chosen-count"]').text()).toBe('1 task chosen');
  });

  it('moves what was ticked under the destination', async () => {
    const wrapper = panel();
    await choose(wrapper, 'Answer support');

    await wrapper.get('[data-testid="move-target"]').setValue('Billing revamp');
    await wrapper.get('[data-testid="move-apply"]').trigger('click');

    expect(wrapper.emitted('move')).toEqual([
      [{ taskIds: ['Answer support'], parentId: 'Billing revamp' }],
    ]);
  });

  it('takes tasks back out to the top level', async () => {
    const wrapper = panel();
    await choose(wrapper, 'Changelog');

    await wrapper.get('[data-testid="move-target"]').setValue('top');
    await wrapper.get('[data-testid="move-apply"]').trigger('click');

    expect(wrapper.emitted('move')).toEqual([[{ taskIds: ['Changelog'], parentId: null }]]);
  });

  it('never offers somewhere inside what is being moved', async () => {
    // The project and everything under it: a destination in there is a cycle,
    // and migration 0004 would refuse it — better not to offer it.
    const wrapper = panel();
    await choose(wrapper, 'Billing revamp');

    const offered = wrapper
      .get('[data-testid="move-target"]')
      .findAll('option')
      .map((option) => option.attributes('value'));

    expect(offered).toEqual(['', 'top', 'Answer support']);
  });

  it('does not move a task its own container is already taking', async () => {
    // Ticking a project and something inside it is ticking the project twice.
    const wrapper = panel();
    await choose(wrapper, 'Billing revamp');
    await choose(wrapper, 'Spec it');

    await wrapper.get('[data-testid="move-target"]').setValue('Answer support');
    await wrapper.get('[data-testid="move-apply"]').trigger('click');

    expect(wrapper.emitted('move')).toEqual([
      [{ taskIds: ['Billing revamp'], parentId: 'Answer support' }],
    ]);
  });

  it('offers no destination that would push a descendant past five', async () => {
    // Moving a two-deep subtree under a task at depth 4 would make its leaves
    // depth 6, which the `tasks_depth_range` CHECK refuses (§4.4).
    const deep = [
      node('One'),
      node('Two', { parentId: 'One', depth: 2, isLeaf: false }),
      node('Three', { parentId: 'Two', depth: 3 }),
      node('Root', { isLeaf: false }),
      node('Child', { parentId: 'Root', depth: 2 }),
    ];
    deep[0]!.isLeaf = false;

    const wrapper = panel({ tasks: deep });
    await choose(wrapper, 'One');

    const offered = wrapper
      .get('[data-testid="move-target"]')
      .findAll('option')
      .map((option) => option.attributes('value'));

    // `Root` is depth 1, so 1 + 1 + 2 = 4 fits; `Child` is depth 2, so 5 would
    // be the leaf's depth — also fine — and nothing deeper is offered.
    expect(offered).toEqual(['', 'top', 'Root', 'Child']);
  });

  it('forgets a choice once the move is made', async () => {
    const wrapper = panel();
    await choose(wrapper, 'Answer support');
    await wrapper.get('[data-testid="move-target"]').setValue('top');
    await wrapper.get('[data-testid="move-apply"]').trigger('click');

    expect(wrapper.find('[data-testid="chosen-bar"]').exists()).toBe(false);
  });
});
