import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignUpView from '@/views/SignUpView.vue';
import SignInView from '@/views/SignInView.vue';
import { MINIMUM_PASSWORD_LENGTH } from '@/lib/session';

/**
 * Creating an account (spec §10.1).
 *
 * The form's job is to make a complete principal and get out of the way. What
 * is worth testing is what it sends, what it says when the server refuses, and
 * that somebody sent here while signed out ends up back where they were going.
 */
function routerFor(initial = '/sign-up'): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'calendar', component: { template: '<p>calendar</p>' } },
      { path: '/settings', name: 'settings', component: { template: '<p>settings</p>' } },
      { path: '/sign-in', name: 'sign-in', component: SignInView },
      { path: '/sign-up', name: 'sign-up', component: SignUpView },
    ],
  });

  void router.push(initial);
  return router;
}

async function view(initial = '/sign-up') {
  const router = routerFor(initial);
  await router.isReady();

  const wrapper = mount(SignUpView, { global: { plugins: [router] }, attachTo: document.body });
  return { wrapper, router };
}

/** Stubs `fetch` with a fixed sign-up outcome, then a session read. */
function stubAuth(signUp: { status: number; body?: unknown }) {
  const calls: { url: string; body: unknown }[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });

    if (url.includes('/sign-up/email')) {
      return new Response(JSON.stringify(signUp.body ?? {}), { status: signUp.status });
    }
    return new Response(
      JSON.stringify({
        user: { id: 'u1', email: 'someone@example.test', displayName: null },
        settings: { locale: null, timeZone: null, firstDayOfWeek: null },
        activeTenantId: 't1',
        contexts: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  return calls;
}

describe('creating an account', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // `attachTo: document.body` leaves the tree behind if a test fails before
    // unmounting, and the next axe run then sees two `<main>` landmarks and
    // blames the wrong test.
    document.body.innerHTML = '';
  });

  it('sends the address, password and name', async () => {
    const calls = stubAuth({ status: 200 });
    const { wrapper } = await view();

    await wrapper.find('[data-testid="sign-up-name"]').setValue('Ada');
    await wrapper.find('[data-testid="sign-up-email"]').setValue('ada@example.test');
    await wrapper.find('[data-testid="sign-up-password"]').setValue('correct-horse-battery');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(calls[0]).toMatchObject({
      body: { email: 'ada@example.test', password: 'correct-horse-battery', name: 'Ada' },
    });
    wrapper.unmount();
  });

  it('lands where the user was going', async () => {
    stubAuth({ status: 200 });
    const { wrapper, router } = await view('/sign-up?next=/settings');

    await wrapper.find('[data-testid="sign-up-email"]').setValue('ada@example.test');
    await wrapper.find('[data-testid="sign-up-password"]').setValue('correct-horse-battery');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // Somebody sent here while signed out should end up back where they were
    // going, whichever door they came through.
    expect(router.currentRoute.value.path).toBe('/settings');
    wrapper.unmount();
  });

  it('says an address is taken, in words that help', async () => {
    stubAuth({
      status: 422,
      body: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'User already exists.' },
    });
    const { wrapper } = await view();

    await wrapper.find('[data-testid="sign-up-email"]').setValue('ada@example.test');
    await wrapper.find('[data-testid="sign-up-password"]').setValue('correct-horse-battery');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // Better Auth says "Use another email", which is an instruction to do the
    // one thing that is probably wrong.
    const message = wrapper.find('[data-testid="sign-up-error"]').text();
    expect(message).toContain('already an account');
    expect(message).toContain('signing in');
    wrapper.unmount();
  });

  it('refuses a short password before asking the server', async () => {
    const calls = stubAuth({ status: 200 });
    const { wrapper } = await view();

    await wrapper.find('[data-testid="sign-up-email"]').setValue('ada@example.test');
    await wrapper.find('[data-testid="sign-up-password"]').setValue('short');
    await flushPromises();

    expect(wrapper.find('[data-testid="sign-up-submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="sign-up-password"]').attributes('aria-invalid')).toBe(
      'true',
    );

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls).toEqual([]);
    wrapper.unmount();
  });

  it('says the rule before it is broken', async () => {
    const { wrapper } = await view();

    // A requirement announced only on rejection is a requirement the user had
    // to fail to learn.
    expect(wrapper.find('[data-testid="password-hint"]').text()).toContain(
      String(MINIMUM_PASSWORD_LENGTH),
    );
    wrapper.unmount();
  });

  it('keeps ?next= when crossing to sign in', async () => {
    const { wrapper } = await view('/sign-up?next=/settings');

    expect(wrapper.find('[data-testid="to-sign-in"]').attributes('href')).toContain('next=');
    wrapper.unmount();
  });

  it('has no axe violations', async () => {
    const { wrapper } = await view();

    const results = await axe.run(wrapper.element, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    wrapper.unmount();
  });
});
