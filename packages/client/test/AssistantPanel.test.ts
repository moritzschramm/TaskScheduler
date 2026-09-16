import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantLauncher from '@/components/assistant/AssistantLauncher.vue';
import { loadSession } from '@/lib/session';
import { resetAssistant, useAssistant } from '@/lib/assistant';

/**
 * The button in the corner, and what is behind it (spec §2.2).
 *
 * Two things are being asserted that are easy to lose: it is reachable without
 * a key — otherwise nobody discovers the feature — and it is *not* a modal, so
 * the week it is rearranging stays visible behind it.
 */

const SESSION = {
  user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada', emailVerified: true },
  settings: { locale: null, timeZone: null, firstDayOfWeek: null },
  assistant: null,
  activeTenantId: 't1',
  contexts: [{ tenantId: 't1', name: 'personal', slug: 'p', role: 'owner', isPersonal: true }],
};

async function launcher(assistant: unknown = null) {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ ...SESSION, assistant }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  await loadSession();

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'schedule', component: { template: '<p>week</p>' } },
      { path: '/settings', name: 'settings', component: { template: '<p>settings</p>' } },
    ],
  });

  await router.push('/');
  await router.isReady();

  return mount(AssistantLauncher, { global: { plugins: [router] }, attachTo: document.body });
}

beforeEach(() => {
  resetAssistant();
  useAssistant().open.value = false;
});

/**
 * Unmounted between cases, because these attach to the document.
 *
 * axe's landmark rules look at the whole page rather than at the subtree it was
 * handed, so a panel left behind by an earlier case is a second banner as far
 * as the last one is concerned.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the floating button', () => {
  it('is there before a key is, so the feature is findable', async () => {
    const wrapper = await launcher(null);
    expect(wrapper.find('[data-testid="assistant-launcher"]').exists()).toBe(true);
  });

  it('opens and closes the panel', async () => {
    const wrapper = await launcher(null);
    expect(wrapper.find('[data-testid="assistant-panel"]').exists()).toBe(false);

    await wrapper.find('[data-testid="assistant-launcher"]').trigger('click');
    expect(wrapper.find('[data-testid="assistant-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="assistant-launcher"]').attributes('aria-expanded')).toBe(
      'true',
    );

    await wrapper.find('[data-testid="assistant-close"]').trigger('click');
    expect(wrapper.find('[data-testid="assistant-panel"]').exists()).toBe(false);
  });

  it('says where to switch it on rather than failing when it is pressed', async () => {
    const wrapper = await launcher(null);
    await wrapper.find('[data-testid="assistant-launcher"]').trigger('click');

    expect(wrapper.find('[data-testid="assistant-off"]').exists()).toBe(true);
    // No composer at all: a field that can only produce an error is worse than
    // a sentence saying what is missing.
    expect(wrapper.find('[data-testid="assistant-input"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="assistant-off"] a').attributes('href')).toBe('/settings');
  });

  it('offers the composer once a key is stored', async () => {
    const wrapper = await launcher({ provider: 'anthropic', model: 'claude-opus-5', hint: '1234' });
    await wrapper.find('[data-testid="assistant-launcher"]').trigger('click');

    expect(wrapper.find('[data-testid="assistant-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="assistant-off"]').exists()).toBe(false);
  });

  it('leaves the page it is over usable', async () => {
    // Not a Reka `Dialog`: a modal would trap focus and cover the calendar,
    // which is the one thing somebody wants to watch while their week is being
    // rearranged. So no `aria-modal`, and the panel is labelled instead.
    const wrapper = await launcher(null);
    await wrapper.find('[data-testid="assistant-launcher"]').trigger('click');

    const panel = wrapper.find('[data-testid="assistant-panel"]');
    expect(panel.attributes('role')).toBe('dialog');
    expect(panel.attributes('aria-modal')).toBeUndefined();
    expect(panel.attributes('aria-label')).toBe('Assistant');
  });

  it('has no accessibility violations, open or closed', async () => {
    const wrapper = await launcher({ provider: 'anthropic', model: 'claude-opus-5', hint: '1234' });
    await wrapper.find('[data-testid="assistant-launcher"]').trigger('click');

    const results = await axe.run(wrapper.element as HTMLElement);
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
