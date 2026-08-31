import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';
import CalendarView from '@/views/CalendarView.vue';
import AuditView from '@/views/AuditView.vue';
import SettingsView from '@/views/SettingsView.vue';
import SignInView from '@/views/SignInView.vue';
import { loadSession, session } from '@/lib/session';

/**
 * Auth-aware routing (plan M10).
 *
 * The guard asks the **server** who we are rather than trusting anything in the
 * browser, because the session lives in an HttpOnly cookie the client cannot
 * read (§10.1). One request on first navigation, cached in the session module
 * thereafter; a 401 from any later read is what re-triggers it.
 *
 * `?next=` is preserved so signing in returns you to the page you asked for,
 * rather than to a dashboard you then have to navigate away from.
 */
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({
    history,
    routes: [
      { path: '/', name: 'calendar', component: CalendarView, meta: { requiresAuth: true } },
      {
        path: '/settings',
        name: 'settings',
        component: SettingsView,
        meta: { requiresAuth: true },
      },
      { path: '/history', name: 'history', component: AuditView, meta: { requiresAuth: true } },
      { path: '/sign-in', name: 'sign-in', component: SignInView },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
  });

  router.beforeEach(async (to) => {
    if (to.meta['requiresAuth'] !== true) return true;

    const active = session.value ?? (await loadSession());
    if (active !== null) return true;

    return { name: 'sign-in', query: { next: to.fullPath } };
  });

  return router;
}
