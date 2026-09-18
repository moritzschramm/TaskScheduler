import { mount } from '@vue/test-utils';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import TaskListPanel from '@/components/panels/TaskListPanel.vue';
import NotificationCentre from '@/components/NotificationCentre.vue';
import { parseCivilDate, weekDays } from '@/lib/time';
import type { FixedBlock, Notification, ScheduledBlock, TaskNode } from '@ambitime/shared';

/**
 * The accessibility pass (spec §14: "target WCAG 2.2 AA. The calendar grid must
 * be keyboard-navigable; every drag-and-drop action needs a keyboard-accessible
 * equivalent").
 *
 * axe is a floor, not a ceiling: it finds the machine-checkable half — missing
 * names, bad contrast, broken roles — and cannot tell whether a gesture has an
 * equivalent. So the drag alternatives are tested by *using* them, below.
 */
const BERLIN = 'Europe/Berlin';
const days = weekDays(parseCivilDate('2026-03-23'), 1);

const task: ScheduledBlock = {
  occurrenceId: 'occ-1',
  taskId: 'task-1',
  title: 'Write the report',
  activityTypeId: 'cat-1',
  start: '2026-03-23T08:00:00.000Z',
  end: '2026-03-23T09:00:00.000Z',
  cooldownMin: 0,
};

const second: ScheduledBlock = {
  ...task,
  occurrenceId: 'occ-2',
  taskId: 'task-2',
  title: 'Review the draft',
  start: '2026-03-24T08:00:00.000Z',
  end: '2026-03-24T09:00:00.000Z',
};

const standup: FixedBlock = {
  appointmentId: 'appt-1',
  title: 'Standup',
  notes: null,
  start: '2026-03-23T10:00:00.000Z',
  end: '2026-03-23T10:30:00.000Z',
  version: 1,
  occurrenceStart: null,
  isRecurring: false,
  isUnavailability: false,
  cooldownMin: 0,
  isInternal: true,
  status: 'confirmed',
};

function grid(editable = true) {
  return mount(WeekGrid, {
    props: {
      days,
      timeZone: BERLIN,
      blocks: [task, second],
      fixedBlocks: [standup],
      editable,
    },
    attachTo: document.body,
  });
}

/** Runs axe over a mounted component and returns violations worth fixing. */
async function violations(element: Element): Promise<axe.Result[]> {
  const results = await axe.run(element, {
    // Colour contrast needs real rendering; jsdom reports every element as
    // transparent, so the rule can only produce noise here. It belongs in a
    // browser pass, and is called out as such rather than silently dropped.
    rules: { 'color-contrast': { enabled: false } },
  });

  return results.violations;
}

describe('the calendar grid', () => {
  it('has no axe violations', async () => {
    const wrapper = grid();
    expect(await violations(wrapper.element)).toEqual([]);
    wrapper.unmount();
  });

  it('names every block in a way that makes sense out of context', () => {
    const wrapper = grid();

    // The visible text is a title and a time range, which read as two
    // unrelated fragments to a screen reader.
    const label = wrapper.find('[data-testid="block-task"]').attributes('aria-label');
    expect(label).toContain('Write the report');
    expect(label).toContain('09:00 to 10:00');
    expect(label).toContain('pick up');

    // An appointment is not movable, so it offers opening instead.
    expect(wrapper.find('[data-testid="block-appointment"]').attributes('aria-label')).toContain(
      'Press Enter to open',
    );
    wrapper.unmount();
  });

  it('says what a block is when there is nothing to say about moving it', () => {
    const wrapper = grid(false);
    const label = wrapper.find('[data-testid="block-task"]').attributes('aria-label');

    expect(label).toContain('Write the report');
    expect(label).not.toContain('pick up');
    wrapper.unmount();
  });

  describe('every drag action has a keyboard equivalent (§14)', () => {
    it('navigates with the arrows when nothing is picked up', async () => {
      const wrapper = grid();
      const blocks = wrapper.findAll('[data-grid-block]');

      (blocks[0]!.element as HTMLElement).focus();
      await blocks[0]!.trigger('keydown', { key: 'ArrowDown' });

      // Arrows read the grid. A grid whose arrows always moved things would be
      // one you could not read with a keyboard, and reading is the commoner act.
      expect(document.activeElement).toBe(blocks[1]!.element);
      expect(blocks[0]!.attributes('data-moving')).toBeUndefined();
      wrapper.unmount();
    });

    it('picks up, moves and drops', async () => {
      const wrapper = grid();
      const block = wrapper.find('[data-testid="block-task"]');
      expect(block.attributes('data-start-min')).toBe('540');

      await block.trigger('keydown', { key: 'Enter' });
      expect(block.attributes('aria-grabbed')).toBe('true');

      await block.trigger('keydown', { key: 'ArrowDown' });
      await block.trigger('keydown', { key: 'ArrowDown' });
      expect(block.attributes('data-start-min')).toBe('570');

      // Nothing has been committed until the drop — the same three-part
      // gesture a drag is.
      expect(wrapper.emitted('moveBlock')).toBeUndefined();

      await block.trigger('keydown', { key: 'Enter' });
      expect(wrapper.emitted('moveBlock')?.[0]?.[0]).toMatchObject({ startMin: 570 });
      wrapper.unmount();
    });

    it('puts a block back on Escape', async () => {
      const wrapper = grid();
      const block = wrapper.find('[data-testid="block-task"]');

      await block.trigger('keydown', { key: 'Enter' });
      await block.trigger('keydown', { key: 'ArrowDown' });
      await block.trigger('keydown', { key: 'Escape' });

      expect(block.attributes('data-start-min')).toBe('540');
      expect(wrapper.emitted('moveBlock')).toBeUndefined();
      wrapper.unmount();
    });

    it('crosses to the next day with left and right', async () => {
      const wrapper = grid();
      const blocks = wrapper.findAll('[data-grid-block]');

      (blocks[0]!.element as HTMLElement).focus();
      await blocks[0]!.trigger('keydown', { key: 'ArrowRight' });

      // Tuesday's task, not Monday's second block: horizontal means the next
      // *day* that has something in it.
      expect((document.activeElement as HTMLElement).getAttribute('data-title')).toBe(
        'Review the draft',
      );
      wrapper.unmount();
    });

    it('announces what a move is doing', async () => {
      const wrapper = grid();
      const block = wrapper.find('[data-testid="block-task"]');

      await block.trigger('keydown', { key: 'Enter' });

      // WCAG 4.1.3. A move that only shows is a move half the users cannot
      // follow.
      const live = wrapper.find('[data-testid="grid-announcement"]');
      expect(live.attributes('aria-live')).toBe('polite');
      expect(live.text()).toContain('picked up');
      wrapper.unmount();
    });
  });
});

describe('the panels', () => {
  const node: TaskNode = {
    id: 't1',
    parentId: null,
    title: 'Write the report',
    notes: null,
    depth: 1,
    path: ['t1'],
    isLeaf: true,
    status: 'active',
    version: 1,
    estimatedDurationMin: 60,
    ownActivityTypeId: null,
    effectiveActivityTypeId: null,
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
  };

  it('has no axe violations in the task tree', async () => {
    // With the quick-add row: four unlabelled inputs in a table is exactly the
    // kind of thing axe is for, and every one of them carries an `aria-label`
    // because the column header is not a label a screen reader will find.
    const wrapper = mount(TaskListPanel, {
      props: { tasks: [node], editable: true, quickAdd: async () => true },
      attachTo: document.body,
    });

    expect(await violations(wrapper.element)).toEqual([]);
    wrapper.unmount();
  });

  it('has no axe violations in the notification centre', async () => {
    const notification: Notification = {
      id: 'n1',
      type: 'hard_constraint_conflict',
      severity: 'alert',
      payload: { message: 'This will miss its deadline.' },
      readAt: null,
      createdAt: '2026-03-23T08:00:00.000Z',
    };

    const wrapper = mount(NotificationCentre, {
      props: { notifications: [notification], submit: async () => true },
      attachTo: document.body,
    });

    expect(await violations(wrapper.element)).toEqual([]);
    wrapper.unmount();
  });
});
