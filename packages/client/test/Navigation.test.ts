import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from '@/components/AppShell.vue';
import { loadSession } from '@/lib/session';

/**
 * The three screens the week is worked on.
 *
 * One page held the grid, the signals, the capacity indicator, the task tree,
 * the backlog and an editor, which made it a list of everything the system
 * knows rather than an answer to a question. The split is what the navigation
 * has to make legible — including which of the three you are on, and not by
 * colour alone (WCAG 1.4.1).
 */
const A_SESSION = {
  user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada', emailVerified: true },
  settings: { locale: null, timeZone: null, firstDayOfWeek: null },
  activeTenantId: 't1',
  contexts: [{ tenantId: 't1', name: 'personal', slug: 'p', role: 'owner', isPersonal: true }],
};

const stub = { template: '<p>page</p>' };

function routerFor(initial: string): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'schedule', component: stub },
      { path: '/tasks', name: 'tasks', component: stub },
      { path: '/categories', name: 'categories', component: stub },
      { path: '/appointments', name: 'appointments', component: stub },
      { path: '/settings', name: 'settings', component: stub },
      { path: '/history', name: 'history', component: stub },
      { path: '/sign-in', name: 'sign-in', component: stub },
    ],
  });
  void router.push(initial);
  return router;
}

async function shell(at: string) {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify(A_SESSION), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await loadSession();

  const router = routerFor(at);
  await router.isReady();
  return mount(AppShell, { global: { plugins: [router] }, attachTo: document.body });
}

describe('the primary navigation', () => {
  beforeEach(() => void vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('offers the three screens, in the order they are used', async () => {
    const wrapper = await shell('/');

    // What to do, and what kind of thing it is — then when that kind may
    // happen. Appointments was a fourth and is now a checkbox on the first:
    // it was this same week with the tasks left out.
    expect(wrapper.findAll('nav a').map((link) => link.text())).toEqual([
      'Schedule',
      'Tasks',
      'Activity types',
    ]);
    expect(wrapper.find('[data-testid="nav-categories"]').attributes('href')).toBe('/categories');
    wrapper.unmount();
  });

  it('says which one you are on, and not only in colour', async () => {
    const onTasks = await shell('/tasks');

    expect(onTasks.find('[data-testid="nav-tasks"]').attributes('aria-current')).toBe('page');
    expect(onTasks.find('[data-testid="nav-schedule"]').attributes('aria-current')).toBeUndefined();
    onTasks.unmount();
  });

  it('does not leave Schedule lit on every route beneath it', async () => {
    // `/` is a prefix of every path, so an active-match rather than an
    // exact-match would mark Schedule current while you stood on Activity
    // types.
    const onCategories = await shell('/categories');

    expect(
      onCategories.find('[data-testid="nav-schedule"]').attributes('aria-current'),
    ).toBeUndefined();
    expect(onCategories.find('[data-testid="nav-categories"]').attributes('aria-current')).toBe(
      'page',
    );
    onCategories.unmount();
  });

  it('has no axe violations', async () => {
    const wrapper = await shell('/');
    const results = await axe.run(wrapper.element, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations).toEqual([]);
    wrapper.unmount();
  });
});
