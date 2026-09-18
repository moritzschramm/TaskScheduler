import { mount } from '@vue/test-utils';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import TaskEditor from '@/components/tasks/TaskEditor.vue';
import type { ActivityType, CommandRequest, TaskNode } from '@ambitime/shared';

/**
 * Spec §4.4's inheritance, as a form.
 *
 * What is asserted is the **command that comes out**, not the markup. The rule
 * that matters is the three-state one — set here, inherited, unset — and the
 * only way to tell those apart from outside is whether the patch carries a
 * value, a `null`, or nothing at all.
 */

const ACTIVITY_TYPES: ActivityType[] = [
  {
    id: '018f0000-0000-7000-8000-0000000000c1',
    name: 'Work',
    defaultCooldownMin: 0,
    color: null,
    version: 1,
  },
  {
    id: '018f0000-0000-7000-8000-0000000000c2',
    name: 'Exercise',
    defaultCooldownMin: 15,
    color: 'orange',
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
    // Categorised by default, because an uncategorised task is now the state
    // the form refuses to produce: no window applies to it, so the solver is
    // never offered it at all (§6.2 rule 1). Tests about the *other* inherited
    // properties should not have to keep re-establishing that.
    ownActivityTypeId: '018f0000-0000-7000-8000-0000000000c1',
    effectiveActivityTypeId: '018f0000-0000-7000-8000-0000000000c1',
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

function editor(props: {
  task: TaskNode | null;
  parent?: TaskNode | null;
  activityTypes?: ActivityType[];
}) {
  const submit = vi.fn<(request: CommandRequest) => Promise<boolean>>().mockResolvedValue(true);

  const wrapper = mount(TaskEditor, {
    props: {
      task: props.task,
      parent: props.parent ?? null,
      calendarId: '018f0000-0000-7000-8000-0000000000ca',
      activityTypes: props.activityTypes ?? ACTIVITY_TYPES,
      timeZone: 'Europe/Berlin',
      submit,
    },
    // The empty-activity-types hint links to where they are made; the form is
    // mounted here without a router.
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
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
      ownActivityTypeId: null,
      effectiveActivityTypeId: ACTIVITY_TYPES[0]!.id,
    });

    const { wrapper } = editor({ task: child });
    const priority = wrapper.find('[data-testid="field-priority"]');

    // No value control at all while inheriting: editing the box *is* what
    // overriding means, so offering one that does not override would be a lie.
    expect(priority.find('[data-testid="task-priority"]').exists()).toBe(false);
    expect(priority.find('[data-testid="inherited-value"]').text()).toContain('7');

    // Activity type has no override toggle — it is required, so "unset" is not a
    // state a task may be in — and inheriting is the first option instead,
    // named after the parent rather than showing a raw id.
    const inheritedOption = wrapper.find('[data-testid="task-activity-type"] option[value=""]');
    expect(inheritedOption.text()).toContain('Work');
    expect(
      (wrapper.find('[data-testid="task-activity-type"]').element as HTMLSelectElement).value,
    ).toBe('');
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

  describe('recurrence — a demand rule, not a time (§8.2)', () => {
    it('sends nothing while the task does not recur', async () => {
      const { wrapper, submit } = editor({ task: task() });

      expect(wrapper.find('[data-testid="recurrence-count"]').exists()).toBe(false);

      await wrapper.find('[data-testid="save-task"]').trigger('click');
      expect(patchOf(submit)['recurrence']).toBeNull();
    });

    it('sends the rule when one is set', async () => {
      const { wrapper, submit } = editor({ task: task() });

      await wrapper.find('[data-testid="recurrence-toggle"]').trigger('click');
      await wrapper.find('[data-testid="recurrence-count"]').setValue('3');
      await wrapper.find('[data-testid="save-task"]').trigger('click');

      // "3× per week" — how much a period should hold, and nothing about when.
      expect(patchOf(submit)['recurrence']).toEqual({
        period: 'week',
        count: 3,
        missedPolicy: 'rollover',
      });
    });

    it('offers the missed-period policy §8.2 requires', async () => {
      const { wrapper, submit } = editor({
        task: task({ recurrence: { period: 'week', count: 2, missedPolicy: 'rollover' } }),
      });

      // A missed workout should not distort the next period; a missed invoice
      // must carry over. Both answers have to be reachable.
      await wrapper.find('[data-testid="recurrence-missed"]').setValue('expire');
      await wrapper.find('[data-testid="save-task"]').trigger('click');

      expect(patchOf(submit)['recurrence']).toMatchObject({ missedPolicy: 'expire' });
    });

    it('clears the rule when recurrence is turned off', async () => {
      const { wrapper, submit } = editor({
        task: task({ recurrence: { period: 'week', count: 3, missedPolicy: 'rollover' } }),
      });

      expect(
        (wrapper.find('[data-testid="recurrence-count"]').element as HTMLInputElement).value,
      ).toBe('3');

      await wrapper.find('[data-testid="recurrence-toggle"]').trigger('click');
      await wrapper.find('[data-testid="save-task"]').trigger('click');

      expect(patchOf(submit)['recurrence']).toBeNull();
    });
  });
});

/**
 * Every task needs an activity type (spec §4.4, §6.2 rule 1).
 *
 * Not a nicety: a task with no *effective* activity type matches no availability
 * window, so it is never offered to the solver — it does not schedule badly, it
 * disappears. The form used to allow it and offered "None" as a choice, which
 * is how a calendar ends up empty with nothing to explain why.
 *
 * The rule is about the effective value, not the own one. §4.4's inheritance
 * has to keep working, or the mechanism is unusable exactly where it is most
 * useful: a subtask under a categorised parent is already covered.
 */
describe('a task cannot be saved without an activity type', () => {
  it('starts a root task on the first activity type rather than on nothing', async () => {
    // An empty box that refuses to save is a worse first impression than a
    // sensible default the user can change, and there is no meaningful
    // alternative to pick from when only one answer is valid.
    const { wrapper, submit } = editor({ task: null });

    expect(
      (wrapper.find('[data-testid="task-activity-type"]').element as HTMLSelectElement).value,
    ).toBe(ACTIVITY_TYPES[0]!.id);

    await wrapper.find('[data-testid="task-title"]').setValue('Write the report');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    expect(submit.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'CreateTask',
      params: { activityTypeId: ACTIVITY_TYPES[0]!.id },
    });
  });

  it('sends the one that was chosen instead', async () => {
    const { wrapper, submit } = editor({ task: null });

    await wrapper.find('[data-testid="task-title"]').setValue('Go for a run');
    await wrapper.find('[data-testid="task-activity-type"]').setValue(ACTIVITY_TYPES[1]!.id);
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    expect(submit.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'CreateTask',
      params: { activityTypeId: ACTIVITY_TYPES[1]!.id },
    });
  });

  it('takes an inherited one as satisfying the rule', async () => {
    // A subtask under a categorised parent already has an effective activity type,
    // and demanding its own would defeat §4.4 in its commonest case.
    const parent = task({
      ownActivityTypeId: ACTIVITY_TYPES[1]!.id,
      effectiveActivityTypeId: ACTIVITY_TYPES[1]!.id,
    });
    const { wrapper, submit } = editor({ task: null, parent });

    await wrapper.find('[data-testid="task-title"]').setValue('A subtask');
    expect(wrapper.find('[data-testid="save-task"]').attributes('disabled')).toBeUndefined();

    await wrapper.find('[data-testid="save-task"]').trigger('click');
    // Sent without an activity type of its own: inheriting is the point.
    expect(submit.mock.calls.at(-1)?.[0]).not.toHaveProperty('params.activityTypeId');
  });

  it('offers no way to choose "none"', async () => {
    const { wrapper } = editor({ task: null });

    const options = wrapper.findAll('[data-testid="task-activity-type"] option');
    const selectable = options.filter((option) => option.attributes('disabled') === undefined);

    expect(selectable).toHaveLength(ACTIVITY_TYPES.length);
    expect(selectable.map((option) => option.attributes('value'))).toEqual(
      ACTIVITY_TYPES.map((activityType) => activityType.id),
    );
  });

  it('says where activity types come from when there are none', async () => {
    const { wrapper } = editor({ task: null, activityTypes: [] });

    expect(wrapper.find('[data-testid="no-activity-types-yet"]').text()).toContain(
      'cannot be scheduled',
    );
    expect(wrapper.find('[data-testid="save-task"]').attributes('disabled')).toBeDefined();
  });
});

/**
 * §14: the form is the longest one in the application, and it is now a modal.
 *
 * The check is here rather than only in the browser because the failure it
 * caught is invisible without one: `InheritedField` prints a `<Label>` it
 * cannot associate with whatever its slot renders, so three of these selects
 * had no accessible name at all — a screen reader announced them as "combo
 * box", three times, with nothing to tell them apart.
 */
describe('the editor is readable without seeing it', () => {
  it('names every control, including the ones inside an inherited field', async () => {
    const { wrapper } = editor({ task: null });
    document.body.appendChild(wrapper.element);

    // Every override on, so the fields that only render when set are rendered.
    for (const toggle of wrapper.findAll('[data-testid="override-toggle"]')) {
      if (toggle.attributes('aria-checked') === 'false') await toggle.trigger('click');
    }

    const results = await axe.run(wrapper.element as Element, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations).toEqual([]);
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});

/**
 * Focus levels, in words rather than in numbers (spec §6.5).
 *
 * "Focus 1" through "Focus 5" said nothing about which end was which, and the
 * direction is not guessable: a lower number reads as *less* demanding to some
 * people and as *more* important to others. The scale runs 1 = shallow to
 * 5 = deep, and the labels now say so.
 */
describe('focus level', () => {
  it('offers the scale in words, deep at the top', () => {
    const { wrapper } = editor({ task: task({ ownFocusLevel: 3, effectiveFocusLevel: 3 }) });

    const options = wrapper.findAll('[data-testid="task-focus"] option');
    expect(options.map((option) => option.text())).toEqual([
      'Very low focus',
      'Low focus',
      'Medium focus',
      'High focus',
      'Very high focus',
    ]);
    // The value the engine compares is still the integer (§6.5).
    expect(options.map((option) => option.attributes('value'))).toEqual(['1', '2', '3', '4', '5']);
  });
});

/**
 * The override control names the action, not the state it lands in.
 *
 * It was a switch labelled "Set here", which left the reader to work out which
 * way it was pointing. A button says what pressing it will do — and can say
 * "Clear" where there is nothing to fall back to and "Use inherited" where
 * there is, which one switch label could not.
 */
describe('the override control', () => {
  it('says what pressing it does', async () => {
    const child = task({
      parentId: 'p',
      ownPriority: null,
      effectivePriority: 7,
    });
    const { wrapper } = editor({ task: child });
    const toggle = wrapper.find('[data-testid="field-priority"] [data-testid="override-toggle"]');

    expect(toggle.text()).toBe('Set a value');
    expect(toggle.attributes('aria-pressed')).toBe('false');

    await toggle.trigger('click');
    expect(toggle.text()).toBe('Use inherited');
    expect(toggle.attributes('aria-pressed')).toBe('true');
  });

  it('offers to clear, not to inherit, when nothing supplies a value', async () => {
    const { wrapper } = editor({ task: task() });
    const toggle = wrapper.find('[data-testid="field-priority"] [data-testid="override-toggle"]');

    await toggle.trigger('click');
    expect(toggle.text()).toBe('Clear');
  });

  it('is gone from the activity type, which is not optional', () => {
    const { wrapper } = editor({ task: null });

    expect(
      wrapper.find('[data-testid="field-activity-type"] [data-testid="override-toggle"]').exists(),
    ).toBe(false);
  });
});

/**
 * A new root task inherits from nothing, and has to say so in words.
 *
 * `inherited` is `null` for a task with no ancestor, and the bindings compared
 * it with `=== null` — which misses `undefined`, so `String(undefined)` reached
 * the screen and three fields read "Inherited: undefined". Caught by looking at
 * the form, not by any assertion: every test here reads the command that comes
 * out, and this never reached one.
 */
describe('with nothing to inherit from', () => {
  it('says "Not set" rather than printing undefined', () => {
    const { wrapper } = editor({ task: null });

    const lines = wrapper.findAll('[data-testid="inherited-value"]').map((line) => line.text());

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line === 'Not set')).toBe(true);
    expect(wrapper.text()).not.toContain('undefined');
  });
});

describe('the days half of a preferred time (§4.4, migration 0021)', () => {
  const field = '[data-testid="field-preferred-weekdays"]';

  it('sends the days it was given, sorted', async () => {
    const { wrapper, submit } = editor({ task: task() });

    await wrapper.find(`${field} [data-testid="override-toggle"]`).trigger('click');
    await wrapper.find('[data-testid="task-weekday-4"]').trigger('click');
    await wrapper.find('[data-testid="task-weekday-2"]').trigger('click');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    expect(patchOf(submit)['preferredWeekdays']).toEqual([2, 4]);
  });

  it('is independent of the hours, which it does not disturb', async () => {
    // "Tuesdays" says nothing about when on a Tuesday, and "afternoons" says
    // nothing about which day: two fields, two switches.
    const { wrapper, submit } = editor({
      task: task({ ownPreferredStartMin: 13 * 60, ownPreferredEndMin: 17 * 60 }),
    });

    await wrapper.find(`${field} [data-testid="override-toggle"]`).trigger('click');
    await wrapper.find('[data-testid="task-weekday-2"]').trigger('click');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    const patch = patchOf(submit);
    expect(patch['preferredWeekdays']).toEqual([2]);
    expect(patch['preferredRange']).toEqual({ startMin: 13 * 60, endMin: 17 * 60 });
  });

  it('clears back to inherited without touching the hours', async () => {
    const { wrapper, submit } = editor({
      task: task({
        ownPreferredWeekdays: [2],
        effectivePreferredWeekdays: [2],
        ownPreferredStartMin: 13 * 60,
        ownPreferredEndMin: 17 * 60,
      }),
    });

    await wrapper.find(`${field} [data-testid="override-toggle"]`).trigger('click');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    const patch = patchOf(submit);
    expect(patch['preferredWeekdays']).toBeNull();
    expect(patch['preferredRange']).toEqual({ startMin: 13 * 60, endMin: 17 * 60 });
  });

  it('shows a container’s days as inherited rather than as its own', () => {
    // Said once on a project and true of everything in it — which is the whole
    // reason the field is worth having.
    const { wrapper } = editor({
      task: task({ depth: 2, ownPreferredWeekdays: null, effectivePreferredWeekdays: [2, 4] }),
    });

    expect(wrapper.find(`${field} [data-testid="inherited-value"]`).text()).toContain('Tue, Thu');
  });

  it('treats no day chosen as no preference rather than as a refusal', async () => {
    // An empty set is what NULL already says, and the column's own constraint
    // rejects it — so the switch alone is not an instruction.
    const { wrapper, submit } = editor({ task: task() });

    await wrapper.find(`${field} [data-testid="override-toggle"]`).trigger('click');
    await wrapper.find('[data-testid="save-task"]').trigger('click');

    expect(patchOf(submit)['preferredWeekdays']).toBeNull();
  });
});
