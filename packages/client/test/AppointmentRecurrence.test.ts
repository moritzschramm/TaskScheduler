import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import type { CommandRequest } from '@ambitime/shared';

/**
 * The rule the form writes (spec §8.1).
 *
 * Asserted as the RRULE string rather than as markup, because that string is
 * the whole contract: the server stores it verbatim and `rrule` expands it, so
 * a form that renders perfectly and emits `FREQ=WEEKLY` where the user asked
 * for six occurrences has failed in the only place it matters.
 */
function editor(props: { defaultStart?: string } = {}) {
  const submit = vi.fn<(request: CommandRequest) => Promise<boolean>>().mockResolvedValue(true);

  const wrapper = mount(AppointmentEditor, {
    props: {
      block: null,
      calendarId: '018f0000-0000-7000-8000-0000000000ca',
      timeZone: 'Europe/Berlin',
      defaultStart: props.defaultStart ?? '2026-03-23T08:00:00.000Z',
      submit,
    },
  });

  return { wrapper, submit };
}

/** The recurrence of the last command sent, if it carried one. */
function ruleOf(submit: ReturnType<typeof vi.fn>): string | undefined {
  const request = submit.mock.calls.at(-1)?.[0] as { params: { recurrence?: { rule: string } } };
  return request.params.recurrence?.rule;
}

async function repeatEvery(
  wrapper: ReturnType<typeof editor>['wrapper'],
  frequency: string,
): Promise<void> {
  await wrapper.find('[data-testid="appointment-title"]').setValue('Standup');
  await wrapper.find('[data-testid="appointment-repeats"]').setValue(true);
  await wrapper.find('[data-testid="appointment-frequency"]').setValue(frequency);
}

describe('when a repeating block stops', () => {
  it('runs on with no end by default', async () => {
    const { wrapper, submit } = editor();
    await repeatEvery(wrapper, 'DAILY');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // A standing meeting has no end, and inventing one would quietly stop it.
    expect(ruleOf(submit)).toBe('FREQ=DAILY');
  });

  it('takes a number of times', async () => {
    const { wrapper, submit } = editor();
    await repeatEvery(wrapper, 'DAILY');
    await wrapper.find('[data-testid="appointment-ends"]').setValue('after');
    await wrapper.find('[data-testid="appointment-count"]').setValue('6');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    expect(ruleOf(submit)).toBe('FREQ=DAILY;COUNT=6');
  });

  it('takes a last day, and includes it', async () => {
    const { wrapper, submit } = editor();
    await repeatEvery(wrapper, 'DAILY');
    await wrapper.find('[data-testid="appointment-ends"]').setValue('on');
    await wrapper.find('[data-testid="appointment-until"]').setValue('2026-03-31');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // 23:59 on the named day, so "until the 31st" happens on the 31st. People
    // name the last day they mean, not the first they do not.
    expect(ruleOf(submit)).toBe('FREQ=DAILY;UNTIL=20260331T235900Z');
  });

  /**
   * The `Z` is a lie the server is in on.
   *
   * These rules are expanded in floating mode — `DTSTART` is a UTC-labelled
   * `Date` spelling the *local* time, so DST correctness comes from the
   * scheduler's own arithmetic rather than the library's. A bound written as a
   * real UTC instant would sit in a different frame from the values it bounds:
   * an hour out, invisible in winter, one dropped instance in summer.
   */
  it('writes the bound in the same wall clock the rule is read in', async () => {
    // A summer date, where Berlin is two hours from UTC. A real instant would
    // have to say 21:59Z to mean the end of the 30th; this says 23:59.
    const { wrapper, submit } = editor({ defaultStart: '2026-07-06T07:00:00.000Z' });
    await repeatEvery(wrapper, 'DAILY');
    await wrapper.find('[data-testid="appointment-ends"]').setValue('on');
    await wrapper.find('[data-testid="appointment-until"]').setValue('2026-07-30');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    expect(ruleOf(submit)).toBe('FREQ=DAILY;UNTIL=20260730T235900Z');
  });

  it('ignores a half-filled bound rather than sending a broken rule', async () => {
    const { wrapper, submit } = editor();
    await repeatEvery(wrapper, 'WEEKLY');
    await wrapper.find('[data-testid="appointment-ends"]').setValue('on');
    // The date is still empty; `UNTIL=` with nothing after it would be refused
    // by the parser at expansion time, long after the save appeared to work.
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    expect(ruleOf(submit)).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('carries the end on an unavailability too', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="kind-unavailability"]').setValue(true);
    await wrapper.find('[data-testid="appointment-repeats"]').setValue(true);
    await wrapper.find('[data-testid="appointment-frequency"]').setValue('DAILY');
    await wrapper.find('[data-testid="appointment-ends"]').setValue('after');
    await wrapper.find('[data-testid="appointment-count"]').setValue('3');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    expect(submit.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'AddUnavailability' });
    expect(ruleOf(submit)).toBe('FREQ=DAILY;COUNT=3');
  });
});
