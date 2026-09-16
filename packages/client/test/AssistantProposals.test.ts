import { describe, expect, it } from 'vitest';
import { toProposal, type Subject } from '@/lib/proposals';
import type { AssistantCall } from '@ambitime/shared';

/**
 * What a person is actually agreeing to (spec §2.2).
 *
 * The plan is rendered from the **command**, not from the model's description
 * of it. That is the difference between "approve this summary" and "approve
 * this change", and it is the property these tests exist to hold: a call whose
 * arguments will not validate is shown as a line that will not run, and a call
 * that will run is described in terms of the week rather than in uuids.
 */

const CALENDAR = '01890000-0000-7000-8000-0000000000c0';
const TASK = '01890000-0000-7000-8000-000000000001';
const BLOCK = '01890000-0000-7000-8000-000000000002';
const WORK = '01890000-0000-7000-8000-0000000000ca';

const HOLIDAY = '01890000-0000-7000-8000-0000000000fa';

/** Monday to Wednesday, 09:00–17:00, as the ordinary set for Work. */
const CURRENT = [1, 2, 3].map((weekday) => ({
  id: `w${weekday}`,
  categoryId: WORK,
  weekTypeOverrideId: null,
  weekday,
  startMin: 540,
  endMin: 1020,
  focusLevel: null,
}));

const subject: Subject = {
  taskTitles: new Map([[TASK, 'Invoices']]),
  blockTitles: new Map([[BLOCK, 'Dentist']]),
  categoryNames: new Map([[WORK, 'Work']]),
  weekNames: new Map([[HOLIDAY, 'Christmas']]),
  availability: CURRENT,
  zone: 'Europe/Berlin',
  locale: 'en-GB',
};

function call(command: AssistantCall['command'], params: Record<string, unknown>): AssistantCall {
  return { id: 'call_1', command, params };
}

describe('turning a model’s call into a proposal', () => {
  it('fills in the calendar the model was never given', () => {
    // Not a convenience: the assistant acts on the planner you are looking at
    // because it has no way to name another one.
    const proposal = toProposal(
      call('CreateTask', { title: 'Invoices', estimatedDurationMin: 45 }),
      CALENDAR,
      subject,
    );

    expect(proposal.problem).toBeNull();
    expect(proposal.request).toEqual({
      type: 'CreateTask',
      params: { calendarId: CALENDAR, title: 'Invoices', estimatedDurationMin: 45 },
    });
  });

  it('describes it in the week’s own words, not in ids', () => {
    const proposal = toProposal(
      call('MoveTask', { taskId: TASK, datetime: '2026-09-17T09:00:00+02:00' }),
      CALENDAR,
      subject,
    );

    expect(proposal.headline).toContain('“Invoices”');
    expect(proposal.headline).not.toContain(TASK);
  });

  it('tells a deferral apart from a move, because the app does', () => {
    const defer = toProposal(
      call('DeferTask', { taskId: TASK, target: 'next_week' }),
      CALENDAR,
      subject,
    );

    expect(defer.headline).toBe('Put “Invoices” off until next week');
  });

  it('says "cancel" when an appointment edit is a cancellation', () => {
    const proposal = toProposal(
      call('EditAppointment', { appointmentId: BLOCK, patch: { status: 'cancelled' } }),
      CALENDAR,
      subject,
    );

    expect(proposal.headline).toBe('Cancel “Dentist”');
  });

  it('spells out the parameters underneath', () => {
    const proposal = toProposal(
      call('CreateTask', {
        title: 'Invoices',
        estimatedDurationMin: 45,
        categoryId: WORK,
        dueDate: { date: '2026-09-18T17:00:00+02:00', kind: 'hard' },
      }),
      CALENDAR,
      subject,
    );

    // The activity type by name, not by id: a reader checking a plan cannot
    // check a uuid.
    expect(proposal.details).toContain('Activity type: Work');
    expect(proposal.details.some((detail) => detail.startsWith('Due:'))).toBe(true);
    expect(proposal.details.some((detail) => detail.includes('hard'))).toBe(true);
    expect(proposal.details).toContain('Estimate (minutes): 45');
  });

  it('refuses arguments the server would refuse, and says which field', () => {
    const proposal = toProposal(
      call('CreateTask', { title: '', estimatedDurationMin: -5 }),
      CALENDAR,
      subject,
    );

    expect(proposal.request).toBeNull();
    expect(proposal.problem).toContain('title');
    expect(proposal.problem).toContain('estimatedDurationMin');
  });

  it('still says what a refused call was trying to do', () => {
    // "A change that will not run" tells a reader nothing about whether to ask
    // again; the title they asked for does. And no placeholder may reach the
    // screen unsubstituted — `New task "{title}"` is worse than either.
    const proposal = toProposal(
      call('CreateTask', { title: 'Broken', estimatedDurationMin: 0 }),
      CALENDAR,
      subject,
    );

    expect(proposal.headline).toBe('New task “Broken”');
    expect(proposal.headline).not.toContain('{');
    expect(proposal.problem).toContain('estimatedDurationMin');
  });

  it('leaves no placeholder behind when the call named nothing at all', () => {
    const proposal = toProposal(call('MoveTask', {}), CALENDAR, subject);

    expect(proposal.headline).not.toContain('{');
    expect(proposal.headline).toContain('something not on this week');
  });

  it('writes times in the zone the calendar is drawn in', () => {
    // §13 lets somebody display a zone that is not their machine's, and a plan
    // line naming the wrong hour is a plan they approve for the wrong hour.
    const berlin = toProposal(
      call('MoveTask', { taskId: TASK, datetime: '2026-09-17T07:00:00Z' }),
      CALENDAR,
      subject,
    );
    const tokyo = toProposal(
      call('MoveTask', { taskId: TASK, datetime: '2026-09-17T07:00:00Z' }),
      CALENDAR,
      { ...subject, zone: 'Asia/Tokyo' },
    );

    expect(berlin.headline).toContain('09:00');
    expect(tokyo.headline).toContain('16:00');
  });

  it('is honest about a task it cannot find', () => {
    // A model naming something that is not on this week is a real state, and
    // inventing a title for it would be the one way to make it invisible.
    const proposal = toProposal(
      call('CompleteTask', { taskId: '01890000-0000-7000-8000-00000000ffff' }),
      CALENDAR,
      subject,
    );

    expect(proposal.headline).toContain('something not on this week');
  });

  it('shows a replaced set as a replacement, naming what would go', () => {
    // `SetAvailabilityWindows` replaces rather than amends, so the interesting
    // half of the plan is what is *missing* from it. "Mon 09:00–17:00, Tue
    // 09:00–17:00" describes a plan that has just deleted Wednesday perfectly
    // accurately, and nobody reads it and notices.
    const proposal = toProposal(
      call('SetAvailabilityWindows', {
        categoryId: WORK,
        windows: [
          { weekday: 1, startMin: 540, endMin: 1020 },
          { weekday: 2, startMin: 540, endMin: 1020 },
        ],
      }),
      CALENDAR,
      subject,
    );

    expect(proposal.headline).toBe('Set when “Work” may be scheduled');
    expect(proposal.details).toContain('Hours: Mon 09:00–17:00, Tue 09:00–17:00');
    expect(proposal.details).toContain('Removed: Wed 09:00–17:00');
  });

  it('says nothing was removed when nothing was', () => {
    const proposal = toProposal(
      call('SetAvailabilityWindows', {
        categoryId: WORK,
        windows: [
          ...[1, 2, 3].map((weekday) => ({ weekday, startMin: 540, endMin: 1020 })),
          { weekday: 4, startMin: 540, endMin: 1020 },
        ],
      }),
      CALENDAR,
      subject,
    );

    expect(proposal.details.some((detail) => detail.startsWith('Removed'))).toBe(false);
  });

  it('calls an empty set what it is, rather than showing a blank', () => {
    // During a holiday this is exactly the intent, so it must read as a
    // decision rather than as a form somebody failed to fill in.
    const proposal = toProposal(
      call('SetAvailabilityWindows', {
        categoryId: WORK,
        weekTypeOverrideId: HOLIDAY,
        windows: [],
      }),
      CALENDAR,
      subject,
    );

    expect(proposal.headline).toBe('Set when “Work” may be scheduled during “Christmas”');
    expect(proposal.details[0]).toContain('none at all');
    // The holiday set is empty already, so nothing is lost by emptying it.
    expect(proposal.details.some((detail) => detail.startsWith('Removed'))).toBe(false);
  });

  it('names the consequence of a delete in the line itself', () => {
    const category = toProposal(call('DeleteCategory', { categoryId: WORK }), CALENDAR, subject);
    const week = toProposal(
      call('DeleteWeekTypeOverride', { weekTypeOverrideId: HOLIDAY }),
      CALENDAR,
      subject,
    );

    expect(category.headline).toBe('Delete the activity type “Work”, and its hours');
    expect(week.headline).toContain('“Christmas”');
    expect(week.headline).toContain('the hours set up for it');
  });

  it('reports a cleared field as cleared rather than as "null"', () => {
    const proposal = toProposal(
      call('EditTask', { taskId: TASK, patch: { priority: null } }),
      CALENDAR,
      subject,
    );

    expect(proposal.details).toContain('Priority: cleared');
  });
});
