import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { resetWorkspace, useWorkspace } from '@/lib/workspace';

/**
 * Saying that a day was blocked out (spec §7.2).
 *
 * `BlockOutDay` closes the day **from now forward**, which is right — the hours
 * already spent are a record of what happened, not something to paint over.
 * What it means for the screen is that the later in the day it is pressed, the
 * less of its effect lands inside the hours the grid is cropped to; measured at
 * 22:14 against the default six-to-ten crop, the change is a block the grid does
 * not reach and the page afterwards is pixel-identical.
 *
 * So there is a line of words, and it carries the hour the day closes from —
 * the one thing a reader cannot get from a grid the change is not on.
 */

beforeEach(() => resetWorkspace());

afterEach(() => {
  vi.unstubAllGlobals();
  resetWorkspace();
});

const status = () => mount(WorkspaceStatus);

describe('the confirmation line', () => {
  it('says what happened, where the week is read', () => {
    const { notice } = useWorkspace();
    notice.value = 'Today is blocked out from 22:14.';

    const wrapper = status();

    expect(wrapper.get('[data-testid="notice"]').text()).toBe('Today is blocked out from 22:14.');
    expect(wrapper.get('[data-testid="notice"]').attributes('role')).toBe('status');
  });

  it('gives way to an error, which is the more urgent thing to read', () => {
    const { notice, error } = useWorkspace();
    notice.value = 'Today is blocked out from 22:14.';
    error.value = 'That change could not be applied';

    const wrapper = status();

    expect(wrapper.find('[data-testid="notice"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="calendar-error"]').text()).toBe(
      'That change could not be applied',
    );
  });

  it('is taken back by the next command, not left standing', async () => {
    // It is a confirmation of the press that caused it. Once something else has
    // happened it is describing a screen that has moved on — the same rule
    // `diverged` follows.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));

    const { notice, submit } = useWorkspace();
    notice.value = 'Today is blocked out from 22:14.';

    await submit({ type: 'BlockOutDay', params: { calendarId: 'cal', date: '2026-03-23' } });
    await flushPromises();

    expect(notice.value).toBeNull();
  });

  it('does not outlive the person it was shown to', () => {
    const { notice } = useWorkspace();
    notice.value = 'Today is blocked out from 22:14.';

    resetWorkspace();

    expect(useWorkspace().notice.value).toBeNull();
  });
});
