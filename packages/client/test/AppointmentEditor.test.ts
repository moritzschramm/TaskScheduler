import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import type { CommandRequest, FixedBlock } from '@ambitime/shared';

/**
 * The two things the form decides on its own: what a block is called, and when
 * it ends (spec §7.4).
 *
 * Asserted on the command rather than on the markup, because the command is
 * what survives the screen. A field that shows the right hour and sends the old
 * one is the failure worth catching, and it looks identical from the outside.
 */
function editor(props: { block?: FixedBlock | null; defaultStart?: string } = {}) {
  const submit = vi.fn<(request: CommandRequest) => Promise<boolean>>().mockResolvedValue(true);

  const wrapper = mount(AppointmentEditor, {
    props: {
      block: props.block ?? null,
      calendarId: '018f0000-0000-7000-8000-0000000000ca',
      timeZone: 'Europe/Berlin',
      defaultStart: props.defaultStart ?? '2026-03-23T08:00:00.000Z',
      submit,
    },
  });

  return { wrapper, submit };
}

function sent(submit: ReturnType<typeof vi.fn>): CommandRequest {
  return submit.mock.calls.at(-1)?.[0] as CommandRequest;
}

const unavailability: FixedBlock = {
  appointmentId: '018f0000-0000-7000-8000-00000000ab01',
  title: 'School run',
  notes: null,
  start: '2026-03-23T13:00:00.000Z',
  end: '2026-03-23T15:00:00.000Z',
  version: 1,
  occurrenceStart: null,
  isRecurring: false,
  isUnavailability: true,
  cooldownMin: 0,
  isInternal: false,
  status: 'confirmed',
};

describe('naming a block that has no availability in it', () => {
  it('carries the title the user gave it', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="kind-unavailability"]').setValue(true);
    await wrapper.find('[data-testid="appointment-title"]').setValue('Dentist');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    const request = sent(submit);
    expect(request.type).toBe('AddUnavailability');
    expect(request.params).toMatchObject({ title: 'Dentist' });
  });

  it('sends no title at all when none was written', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="kind-unavailability"]').setValue(true);
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // Absent rather than empty: that is what tells every reader downstream to
    // supply its own word, in its own language (§7.4).
    expect(sent(submit).params).not.toHaveProperty('title');
  });

  it('saves without one, where an appointment could not', async () => {
    const { wrapper } = editor();
    await wrapper.find('[data-testid="kind-unavailability"]').setValue(true);
    expect(wrapper.find('[data-testid="save-appointment"]').attributes('disabled')).toBeUndefined();

    await wrapper.find('[data-testid="kind-appointment"]').setValue(true);
    expect(wrapper.find('[data-testid="save-appointment"]').attributes('disabled')).toBeDefined();
  });

  it('takes the title away again as null, not as an empty string', async () => {
    const { wrapper, submit } = editor({ block: unavailability });
    await wrapper.find('[data-testid="appointment-title"]').setValue('');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // The column cannot be null and the patch can: `null` is the instruction to
    // clear, and it is the only way back to an unlabelled block.
    expect(sent(submit).params).toMatchObject({ patch: { title: null } });
  });
});

describe('when the start moves', () => {
  it('puts the end an hour after it', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="appointment-title"]').setValue('Review');
    await wrapper.find('[data-testid="appointment-start"]').setValue('2026-03-23T16:30');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    const params = sent(submit).params as { start: string; end: string };
    expect(params.start).toBe('2026-03-23T15:30:00.000Z');
    expect(params.end).toBe('2026-03-23T16:30:00.000Z');
  });

  it('leaves an end the user set afterwards alone', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="appointment-title"]').setValue('Workshop');
    await wrapper.find('[data-testid="appointment-start"]').setValue('2026-03-23T09:00');
    await wrapper.find('[data-testid="appointment-end"]').setValue('2026-03-23T17:00');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // The hour is a default, not a rule: the second field is still the answer
    // whenever somebody gives one.
    expect((sent(submit).params as { end: string }).end).toBe('2026-03-23T16:00:00.000Z');
  });

  it('keeps the length of a block that already has one', async () => {
    // A two-hour block moved to the afternoon is still two hours. Resetting it
    // to an hour would shorten a meeting nobody asked to shorten.
    const { wrapper } = editor({ block: unavailability });
    await wrapper.find('[data-testid="appointment-start"]').setValue('2026-03-23T18:00');

    const end = wrapper.find('[data-testid="appointment-end"]').element as HTMLInputElement;
    expect(end.value).toBe('2026-03-23T20:00');
  });

  it('keeps a length the user has just set on a new block', async () => {
    const { wrapper } = editor();
    await wrapper.find('[data-testid="appointment-end"]').setValue('2026-03-23T17:00');
    await wrapper.find('[data-testid="appointment-start"]').setValue('2026-03-23T10:00');

    // The seed is an hour and stays an hour until somebody says otherwise; the
    // eight hours typed above are what "otherwise" looks like.
    const end = wrapper.find('[data-testid="appointment-end"]').element as HTMLInputElement;
    expect(end.value).toBe('2026-03-23T18:00');
  });

  it('falls back to an hour when the length on screen is not one', async () => {
    const { wrapper } = editor();
    // An end before the start describes no span at all, so there is nothing to
    // preserve and the default takes over.
    await wrapper.find('[data-testid="appointment-end"]').setValue('2026-03-23T05:00');
    await wrapper.find('[data-testid="appointment-start"]').setValue('2026-03-23T14:00');

    const end = wrapper.find('[data-testid="appointment-end"]').element as HTMLInputElement;
    expect(end.value).toBe('2026-03-23T15:00');
  });

  it('never leaves the form showing a block that runs backwards', async () => {
    const { wrapper } = editor({ defaultStart: '2026-03-23T08:00:00.000Z' });
    await wrapper.find('[data-testid="appointment-title"]').setValue('Late thing');
    // The end was 09:00 and the new start is after it — the case that used to
    // produce a red line for a form the user had only half filled in.
    await wrapper.find('[data-testid="appointment-start"]').setValue('2026-03-23T20:00');

    expect(wrapper.find('[data-testid="interval-invalid"]').exists()).toBe(false);
  });
});

describe('the gap a block leaves after itself', () => {
  it('is sent only when there is one', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="appointment-title"]').setValue('Offsite');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // Zero is the column's default, so an omitted value and a typed zero mean
    // the same thing and the log carries neither.
    expect(sent(submit).params).not.toHaveProperty('cooldownMin');
  });

  it('travels with a new appointment', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="appointment-title"]').setValue('Offsite');
    await wrapper.find('[data-testid="appointment-cooldown"]').setValue('20');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    expect(sent(submit).params).toMatchObject({ cooldownMin: 20 });
  });

  it('travels with an unavailability too', async () => {
    const { wrapper, submit } = editor();
    await wrapper.find('[data-testid="kind-unavailability"]').setValue(true);
    await wrapper.find('[data-testid="appointment-cooldown"]').setValue('45');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // The engine draws no distinction between the two (§7.4), and neither
    // should the form: recovering from a hospital appointment is the case.
    expect(sent(submit).type).toBe('AddUnavailability');
    expect(sent(submit).params).toMatchObject({ cooldownMin: 45 });
  });

  it('can be taken back down to zero on an edit', async () => {
    const { wrapper, submit } = editor({ block: { ...unavailability, cooldownMin: 30 } });
    const field = wrapper.find('[data-testid="appointment-cooldown"]').element;
    expect((field as HTMLInputElement).value).toBe('30');

    await wrapper.find('[data-testid="appointment-cooldown"]').setValue('0');
    await wrapper.find('[data-testid="save-appointment"]').trigger('click');

    // Always sent on an edit, zero included: this is the only place the value
    // can be reduced, so an omission here would make it a one-way door.
    expect(sent(submit).params).toMatchObject({ patch: { cooldownMin: 0 } });
  });
});
