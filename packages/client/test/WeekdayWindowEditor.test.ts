import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import WeekdayWindowEditor, {
  type WindowRule,
} from '@/components/settings/WeekdayWindowEditor.vue';

/**
 * The weekly editor behind both of §9.1's calendar windows and §4.3's
 * availability.
 *
 * What is worth testing here is the *model* it produces, not its markup: the
 * commands it feeds replace whole sets, so an editor that quietly drops a range
 * or invents one writes exactly that to the database.
 */
function editor(modelValue: WindowRule[] = []) {
  return mount(WeekdayWindowEditor, {
    props: { modelValue, timeZone: 'Europe/Berlin' },
  });
}

/** The set the Save button would send — the last value the editor emitted. */
function emittedModel(wrapper: ReturnType<typeof editor>): WindowRule[] | undefined {
  const emitted = wrapper.emitted('update:modelValue');
  return emitted?.[emitted.length - 1]?.[0] as WindowRule[] | undefined;
}

describe('the weekday window editor', () => {
  it('groups ranges under the weekday they fall on', () => {
    const wrapper = editor([
      { weekday: 3, startMin: 540, endMin: 720 },
      { weekday: 1, startMin: 540, endMin: 1020 },
    ]);

    expect(
      wrapper.find('[data-testid="weekday-1"]').findAll('[data-testid="window-range"]'),
    ).toHaveLength(1);
    expect(
      wrapper.find('[data-testid="weekday-2"]').findAll('[data-testid="window-range"]'),
    ).toHaveLength(0);
    expect(
      wrapper.find('[data-testid="weekday-3"]').findAll('[data-testid="window-range"]'),
    ).toHaveLength(1);
  });

  it('says a weekday with no ranges is unavailable', () => {
    const wrapper = editor([{ weekday: 1, startMin: 540, endMin: 1020 }]);

    expect(wrapper.find('[data-testid="weekday-2"]').text()).toContain('Unavailable');
    expect(wrapper.find('[data-testid="weekday-1"]').text()).not.toContain('Unavailable');
  });

  it('holds several ranges on one weekday', async () => {
    // A day split around lunch is ordinary, and the scheduler resolves a
    // weekday's ranges as a union — an editor with one row per weekday would
    // have made it inexpressible.
    const wrapper = editor([{ weekday: 1, startMin: 9 * 60, endMin: 12 * 60 }]);

    await wrapper.find('[data-testid="add-range-1"]').trigger('click');

    expect(emittedModel(wrapper)).toHaveLength(2);
    // The new range starts an hour after the last one ends, so the common case
    // is valid with no typing.
    expect(emittedModel(wrapper)?.[1]).toEqual({ weekday: 1, startMin: 13 * 60, endMin: 14 * 60 });
  });

  it('sorts a weekday’s ranges by start time however they arrive', () => {
    const wrapper = editor([
      { weekday: 1, startMin: 13 * 60, endMin: 17 * 60 },
      { weekday: 1, startMin: 9 * 60, endMin: 12 * 60 },
    ]);

    const starts = wrapper
      .find('[data-testid="weekday-1"]')
      .findAll('input[type="time"]')
      .map((input) => (input.element as HTMLInputElement).value);

    expect(starts).toEqual(['09:00', '12:00', '13:00', '17:00']);
  });

  it('ignores a half-typed time rather than storing a number for it', async () => {
    const wrapper = editor([{ weekday: 1, startMin: 9 * 60, endMin: 17 * 60 }]);

    const start = wrapper.find('[data-testid="weekday-1"] input[type="time"]');
    await start.setValue('');

    // The model is what the Save button sends. Emitting nothing is what keeps
    // an emptied field from becoming midnight.
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();

    await start.setValue('11:30');
    expect(emittedModel(wrapper)?.[0]).toEqual({
      weekday: 1,
      startMin: 11 * 60 + 30,
      endMin: 17 * 60,
    });
  });

  it('flags a range that ends before it starts', () => {
    const wrapper = editor([{ weekday: 1, startMin: 17 * 60, endMin: 9 * 60 }]);

    // The command would refuse it; saying so here means the user finds out
    // where they typed it rather than after pressing Save.
    expect(wrapper.find('[data-testid="weekday-1"]').text()).toContain('Ends before it starts');
  });

  it('removes one range without disturbing the others', async () => {
    const wrapper = editor([
      { weekday: 1, startMin: 9 * 60, endMin: 12 * 60 },
      { weekday: 1, startMin: 13 * 60, endMin: 17 * 60 },
    ]);

    await wrapper.find('[data-testid="weekday-1"] [data-testid="remove-range"]').trigger('click');

    expect(emittedModel(wrapper)).toEqual([{ weekday: 1, startMin: 13 * 60, endMin: 17 * 60 }]);
  });

  it('names the zone the times are in', () => {
    // 09:00 is a different moment depending on the answer, and somebody
    // configuring a Berlin calendar from Lisbon should not have to work it out.
    expect(editor().text()).toContain('Europe/Berlin');
  });

  it('offers a focus profile only where one exists', () => {
    const rules = [{ weekday: 1, startMin: 540, endMin: 1020 }];

    expect(editor(rules).findAll('[data-slot="select"]')).toHaveLength(0);

    const withFocus = mount(WeekdayWindowEditor, {
      props: { modelValue: rules, timeZone: 'UTC', withFocus: true },
    });
    expect(withFocus.findAll('[data-slot="select"]')).toHaveLength(1);
  });
});
