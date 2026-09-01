import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';
import ScheduleView from '@/views/ScheduleView.vue';
import TasksView from '@/views/TasksView.vue';
import AppointmentsView from '@/views/AppointmentsView.vue';
import AuditView from '@/views/AuditView.vue';
import SettingsView from '@/views/SettingsView.vue';
import SignInView from '@/views/SignInView.vue';
import SignUpView from '@/views/SignUpView.vue';
import ForgotPasswordView from '@/views/ForgotPasswordView.vue';
import ResetPasswordView from '@/views/ResetPasswordView.vue';
import VerifyEmailView from '@/views/VerifyEmailView.vue';
import { loadSession, RESET_PASSWORD_PATH, session, VERIFY_EMAIL_PATH } from '@/lib/session';

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
      /**
       * Three views of one week, not three applications (§6.1).
       *
       * Schedule answers "when", Tasks answers "what", and Appointments is the
       * fixed time the first two are arranged around. They were one screen and
       * it had become a list of everything the system knows; splitting them is
       * what lets each be short enough to read. All three share the workspace,
       * so the week you paged to is the week you find on the next tab.
       */
      { path: '/', name: 'schedule', component: ScheduleView, meta: { requiresAuth: true } },
      { path: '/tasks', name: 'tasks', component: TasksView, meta: { requiresAuth: true } },
      {
        path: '/appointments',
        name: 'appointments',
        component: AppointmentsView,
        meta: { requiresAuth: true },
      },
      {
        path: '/settings',
        name: 'settings',
        component: SettingsView,
        meta: { requiresAuth: true },
      },
      { path: '/history', name: 'history', component: AuditView, meta: { requiresAuth: true } },
      { path: '/sign-in', name: 'sign-in', component: SignInView },
      { path: '/sign-up', name: 'sign-up', component: SignUpView },
      { path: '/forgot-password', name: 'forgot-password', component: ForgotPasswordView },
      /**
       * The two an email links to, so their paths come from the module that
       * promised them rather than being retyped here (§10.1).
       *
       * Both are public and both must stay that way. A reset link is followed
       * by somebody who by definition cannot sign in, and a confirmation link
       * by somebody whose session may be in another browser entirely — sending
       * either to the sign-in form would strand exactly the person it is for.
       */
      { path: RESET_PASSWORD_PATH, name: 'reset-password', component: ResetPasswordView },
      { path: VERIFY_EMAIL_PATH, name: 'verify-email', component: VerifyEmailView },
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
