import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ActivityTypesSection from '@/components/settings/ActivityTypesSection.vue';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

/**
 * The colour picker of spec §4.3, after migration 0018.
 *
 * Every activity type has a colour. What used to be "No colour" on both rows
 * meant two different things depending which row you were on — "choose for me"
 * on the new one, "take the colour away" on an existing one — and only the
 * first of those is something anybody wants.
 */
function section(activityTypes: CalendarConfiguration['activityTypes']) {
  const submit = vi.fn<(request: CommandRequest) => Promise<boolean>>().mockResolvedValue(true);

  const wrapper = mount(ActivityTypesSection, {
    props: {
      // The section reads nothing else off the configuration.
      configuration: { activityTypes } as CalendarConfiguration,
      submit,
    },
  });

  return { wrapper, submit };
}

const work = {
  id: 'cat-work',
  name: 'Work',
  defaultCooldownMin: 0,
  color: 'blue' as const,
  version: 1,
};

describe('picking a colour for an activity type', () => {
  it('offers no way to take one away', () => {
    const options = section([work])
      .wrapper.find('[data-testid="activity-type-color"]')
      .findAll('option')
      .map((option) => option.attributes('value'));

    expect(options).not.toContain('');
    expect(options).toHaveLength(8);
  });

  it('shows a type that has none as it is, without offering it back', () => {
    // A type made before every one of them had a colour, or one an undo put
    // back that way. The select has to be able to show its state.
    const { wrapper } = section([{ ...work, color: null }]);
    const blank = wrapper.find('[data-testid="activity-type-color"]').findAll('option')[0]!;

    expect(blank.attributes('value')).toBe('');
    expect(blank.attributes('disabled')).toBeDefined();
  });

  it('leaves a colourless type alone until somebody picks one', async () => {
    const { wrapper, submit } = section([{ ...work, color: null }]);

    await wrapper.find('[data-testid="activity-type-name"]').setValue('Work things');
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The patch carries the name and not a `color: null` that would rewrite
    // the state the row is only reporting.
    const request = submit.mock.calls.at(-1)?.[0] as { params: { patch: object } } | undefined;
    expect(request?.params.patch).not.toHaveProperty('color');
  });

  it('says what the blank on the new-type row actually does', () => {
    const { wrapper } = section([work]);
    const blank = wrapper.find('[data-testid="new-activity-type-color"]').findAll('option')[0]!;

    // It has never meant "no colour": the server takes the next free slot,
    // which is how the first three types end up in the three hues that
    // separate for every reader.
    expect(blank.attributes('value')).toBe('');
    expect(blank.text()).toBe('Choose one for me');
  });
});
