import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from '@/components/AppShell.vue';
import VerifyEmailView from '@/views/VerifyEmailView.vue';
import { loadSession } from '@/lib/session';

/**
 * Confirming an address (spec §10.1, §11).
 *
 * Two surfaces, and the split is deliberate. The banner is what an unconfirmed
 * account sees while using the application, and it must never block; the
 * landing page is where the link arrives, and it reports rather than acts —
 * the server verified the token before it redirected.
 */
const A_SESSION = (emailVerified: boolean) => ({
  user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada', emailVerified },
  settings: { locale: null, timeZone: null, firstDayOfWeek: null },
  activeTenantId: 't1',
  contexts: [{ tenantId: 't1', name: 'personal', slug: 'p', role: 'owner', isPersonal: true }],
});

/** Routes `/api/me` to a session and everything else to a fixed outcome. */
function stub(session: unknown, outcome: { status: number; body?: unknown } = { status: 200 }) {
  const calls: { url: string; body: unknown }[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });

    if (url.includes('/api/me')) {
      return new Response(session === null ? '' : JSON.stringify(session), {
        status: session === null ? 401 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(outcome.body ?? {}), { status: outcome.status });
  });

  return calls;
}

function routerFor(initial: string): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'calendar', component: { template: '<p>calendar</p>' } },
      { path: '/history', name: 'history', component: { template: '<p>history</p>' } },
      { path: '/settings', name: 'settings', component: { template: '<p>settings</p>' } },
      { path: '/sign-in', name: 'sign-in', component: { template: '<p>sign in</p>' } },
      { path: '/verify-email', name: 'verify-email', component: VerifyEmailView },
    ],
  });
  void router.push(initial);
  return router;
}

describe('the unconfirmed-address banner', () => {
  beforeEach(() => void vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function shell(emailVerified: boolean) {
    stub(A_SESSION(emailVerified));
    await loadSession();

    const router = routerFor('/');
    await router.isReady();
    return mount(AppShell, { global: { plugins: [router] }, attachTo: document.body });
  }

  it('appears only while the address is unconfirmed', async () => {
    const showing = await shell(false);
    expect(showing.find('[data-testid="unverified-banner"]').exists()).toBe(true);
    showing.unmount();

    const quiet = await shell(true);
    expect(quiet.find('[data-testid="unverified-banner"]').exists()).toBe(false);
    quiet.unmount();
  });

  it('says what it costs rather than what it is', async () => {
    const wrapper = await shell(false);

    // "Your email is unverified" is a fact about a database column. §11's
    // warnings going nowhere is the thing a person would want to fix.
    expect(wrapper.find('[data-testid="unverified-banner"]').text()).toContain('reach you');
    wrapper.unmount();
  });

  it('never blocks the application behind it', async () => {
    const wrapper = await shell(false);

    // A notice, not a gate: verification is not required by default, so an
    // unconfirmed account works fine and the banner must not pretend otherwise.
    expect(wrapper.find('[data-testid="unverified-banner"]').attributes('role')).toBe('status');
    expect(wrapper.find('#main').exists()).toBe(true);
    expect(wrapper.find('[data-testid="dismiss-verification"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('goes away when dismissed', async () => {
    const wrapper = await shell(false);

    await wrapper.find('[data-testid="dismiss-verification"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="unverified-banner"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('sends another link, to the address on the session', async () => {
    stub(A_SESSION(false));
    await loadSession();
    const calls = stub(A_SESSION(false));

    const router = routerFor('/');
    await router.isReady();
    const wrapper = mount(AppShell, { global: { plugins: [router] }, attachTo: document.body });

    await wrapper.find('[data-testid="resend-verification"]').trigger('click');
    await flushPromises();

    const request = calls.find((call) => call.url.includes('send-verification-email'));
    // Never a typed address: the endpoint refuses one that is not the
    // session's, and offering a field would invite exactly that refusal.
    expect(request?.body).toEqual({
      email: 'ada@example.test',
      callbackURL: '/verify-email',
    });
    expect(wrapper.find('[data-testid="verification-resent"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('has no axe violations', async () => {
    const wrapper = await shell(false);
    const results = await axe.run(wrapper.element, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    wrapper.unmount();
  });
});

describe('where a confirmation link lands', () => {
  beforeEach(() => void vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function landing(query: string, session: unknown = A_SESSION(true)) {
    stub(session);
    const router = routerFor(`/verify-email${query}`);
    await router.isReady();

    const wrapper = mount(VerifyEmailView, {
      global: { plugins: [router] },
      attachTo: document.body,
    });
    await flushPromises();
    return wrapper;
  }

  it('reports success when the server sent no error', async () => {
    const wrapper = await landing('');

    // The verifying already happened; this page is the receipt.
    expect(wrapper.text()).toContain('confirmed');
    expect(wrapper.find('[data-testid="verified-continue"]').attributes('href')).toBe('/');
    wrapper.unmount();
  });

  it('distinguishes an expired link from a spent one', async () => {
    const expired = await landing('?error=TOKEN_EXPIRED');
    expect(expired.find('[data-testid="verify-error"]').text()).toContain('expired');
    expired.unmount();

    const invalid = await landing('?error=INVALID_TOKEN');
    expect(invalid.find('[data-testid="verify-error"]').text()).toContain('already been used');
    invalid.unmount();
  });

  it('offers a fresh link to somebody signed in', async () => {
    const wrapper = await landing('?error=TOKEN_EXPIRED', A_SESSION(false));

    await wrapper.find('[data-testid="verify-resend"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="verify-resent"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('points a signed-out reader at sign-in instead', async () => {
    const wrapper = await landing('?error=INVALID_TOKEN', null);

    // A dead link carries no identity — the token *was* the identity — so
    // there is no address to send anything to.
    expect(wrapper.find('[data-testid="verify-resend"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Sign in');
    wrapper.unmount();
  });

  it('has no axe violations in either state', async () => {
    for (const query of ['', '?error=INVALID_TOKEN']) {
      const wrapper = await landing(query);
      const results = await axe.run(wrapper.element, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(results.violations).toEqual([]);
      wrapper.unmount();
      document.body.innerHTML = '';
    }
  });
});
