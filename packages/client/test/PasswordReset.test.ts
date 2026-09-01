import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordView from '@/views/ForgotPasswordView.vue';
import ResetPasswordView from '@/views/ResetPasswordView.vue';
import SignInView from '@/views/SignInView.vue';

/**
 * The two halves of a forgotten password (spec §10.1).
 *
 * Asking is one page and redeeming is another because a link in an email is
 * what joins them, and a link can only arrive at a URL. What is worth testing
 * is what each sends, and what each says in the two states a person actually
 * hits: the confirmation that must not reveal whether the address exists, and
 * the link that has already been used.
 */
function routerFor(initial: string): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'calendar', component: { template: '<p>calendar</p>' } },
      { path: '/sign-in', name: 'sign-in', component: SignInView },
      { path: '/forgot-password', name: 'forgot-password', component: ForgotPasswordView },
      { path: '/reset-password', name: 'reset-password', component: ResetPasswordView },
    ],
  });

  void router.push(initial);
  return router;
}

async function view(component: unknown, initial: string) {
  const router = routerFor(initial);
  await router.isReady();

  const wrapper = mount(component as never, {
    global: { plugins: [router] },
    attachTo: document.body,
  });
  return { wrapper, router };
}

/** Stubs `fetch` with one fixed outcome, recording what was asked for. */
function stub(outcome: { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; body: unknown }[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(outcome.body ?? {}), {
      status: outcome.status,
      headers: outcome.headers ?? {},
    });
  });

  return calls;
}

describe('asking for a reset link', () => {
  beforeEach(() => void vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('sends the address and the page the link should land on', async () => {
    const calls = stub({ status: 200 });
    const { wrapper } = await view(ForgotPasswordView, '/forgot-password');

    await wrapper.find('[data-testid="forgot-email"]').setValue('ada@example.test');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(calls[0]?.url).toContain('/request-password-reset');
    // The landing path travels with the request because only the client knows
    // its own routes; the server checks it against the trusted origins.
    expect(calls[0]?.body).toMatchObject({
      email: 'ada@example.test',
      redirectTo: '/reset-password',
    });
    wrapper.unmount();
  });

  it('says the same thing whether or not the address exists', async () => {
    stub({ status: 200 });
    const { wrapper } = await view(ForgotPasswordView, '/forgot-password');

    await wrapper.find('[data-testid="forgot-email"]').setValue('nobody@example.test');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // The server answers identically for both and never composes a message for
    // an address with no account, so the conditional is a description rather
    // than a hedge — see the endpoint test in the server package.
    const confirmation = wrapper.find('[data-testid="reset-requested"]');
    expect(confirmation.exists()).toBe(true);
    expect(confirmation.text()).toContain('has an Ambitime account');
    expect(confirmation.attributes('role')).toBe('status');
    wrapper.unmount();
  });

  it('reports being rate limited as being rate limited', async () => {
    stub({ status: 429, headers: { 'retry-after': '45' } });
    const { wrapper } = await view(ForgotPasswordView, '/forgot-password');

    await wrapper.find('[data-testid="forgot-email"]').setValue('ada@example.test');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // And not as a confirmation. Somebody told "a link is on its way" who is
    // not going to get one waits for a mail that will never arrive.
    expect(wrapper.find('[data-testid="reset-requested"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="forgot-error"]').text()).toContain('45 seconds');
    wrapper.unmount();
  });

  it('has no axe violations', async () => {
    const { wrapper } = await view(ForgotPasswordView, '/forgot-password');
    const results = await axe.run(wrapper.element, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    wrapper.unmount();
  });
});

describe('choosing a new password', () => {
  beforeEach(() => void vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('sends the token from the link with the new password', async () => {
    const calls = stub({ status: 200 });
    const { wrapper } = await view(ResetPasswordView, '/reset-password?token=abc123');

    await wrapper.find('[data-testid="new-password"]').setValue('a-brand-new-passphrase');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(calls[0]?.body).toEqual({ token: 'abc123', newPassword: 'a-brand-new-passphrase' });
    wrapper.unmount();
  });

  it('returns to sign in, because the reset ended every session', async () => {
    stub({ status: 200 });
    const { wrapper, router } = await view(ResetPasswordView, '/reset-password?token=abc123');

    await wrapper.find('[data-testid="new-password"]').setValue('a-brand-new-passphrase');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('sign-in');
    wrapper.unmount();
  });

  it('offers a new link when the old one is dead', async () => {
    const calls = stub({ status: 200 });
    const { wrapper } = await view(ResetPasswordView, '/reset-password?error=INVALID_TOKEN');

    // The server consumed or rejected the token before redirecting here, so
    // there is nothing to submit and no point offering a form.
    expect(wrapper.find('[data-testid="reset-link-dead"]').exists()).toBe(true);
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.find('[data-testid="request-another"]').attributes('href')).toBe(
      '/forgot-password',
    );
    expect(calls).toEqual([]);
    wrapper.unmount();
  });

  it('treats a link with no token at all the same way', async () => {
    const { wrapper } = await view(ResetPasswordView, '/reset-password');

    // Somebody who typed the URL, or a mail client that mangled the query.
    expect(wrapper.find('[data-testid="reset-link-dead"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('refuses a short password before asking the server', async () => {
    const calls = stub({ status: 200 });
    const { wrapper } = await view(ResetPasswordView, '/reset-password?token=abc123');

    await wrapper.find('[data-testid="new-password"]').setValue('short');
    await flushPromises();

    expect(wrapper.find('[data-testid="reset-submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="new-password"]').attributes('aria-invalid')).toBe('true');

    // A disabled button stops a click, not Enter in the field.
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls).toEqual([]);
    wrapper.unmount();
  });

  it('says when the server rejected the token anyway', async () => {
    stub({ status: 400, body: { code: 'INVALID_TOKEN' } });
    const { wrapper } = await view(ResetPasswordView, '/reset-password?token=stale');

    await wrapper.find('[data-testid="new-password"]').setValue('a-brand-new-passphrase');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const message = wrapper.find('[data-testid="reset-error"]').text();
    expect(message).toContain('expired');
    expect(message).toContain('new one');
    wrapper.unmount();
  });

  it('has no axe violations', async () => {
    const { wrapper } = await view(ResetPasswordView, '/reset-password?token=abc123');
    const results = await axe.run(wrapper.element, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    wrapper.unmount();
  });
});
