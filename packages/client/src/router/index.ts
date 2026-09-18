import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';
import ScheduleView from '@/views/ScheduleView.vue';
import SignInView from '@/views/SignInView.vue';
import { loadSession, RESET_PASSWORD_PATH, session, VERIFY_EMAIL_PATH } from '@/lib/session';

/**
 * Every view but two is loaded when it is first visited.
 *
 * The application shipped as one 489 kB bundle, which meant the sign-in form
 * carried the scheduling engine, the table library and every dialog in the
 * app — for a page whose entire content is two fields. Splitting on the route
 * is the standard remedy and costs nothing at runtime: a chunk is fetched
 * once, on a navigation the user has already committed to.
 *
 * **Schedule and sign-in stay eager.** They are the two landing pages — one of
 * them is where every session begins — and a lazily-loaded landing page trades
 * a smaller bundle for a blank screen at the exact moment somebody is deciding
 * whether the application works.
 */
const TasksView = () => import('@/views/TasksView.vue');
const ActivityTypesView = () => import('@/views/ActivityTypesView.vue');
const AuditView = () => import('@/views/AuditView.vue');
const SettingsView = () => import('@/views/SettingsView.vue');
const SignUpView = () => import('@/views/SignUpView.vue');
const ForgotPasswordView = () => import('@/views/ForgotPasswordView.vue');
const ResetPasswordView = () => import('@/views/ResetPasswordView.vue');
const VerifyEmailView = () => import('@/views/VerifyEmailView.vue');

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
       * Two views of one week, not two applications (§6.1).
       *
       * Schedule answers "when" and Tasks answers "what". They were one screen
       * and it had become a list of everything the system knows; splitting them
       * is what lets each be short enough to read, and they share the
       * workspace, so the week you paged to is the week you find on the next
       * tab.
       *
       * There was a third, Appointments, and it was this same week with the
       * tasks left out — a way of looking rather than a place to be. It is a
       * checkbox in the display options now, and the fixed blocks it created
       * are made from the button beside "New task".
       */
      { path: '/', name: 'schedule', component: ScheduleView, meta: { requiresAuth: true } },
      { path: '/tasks', name: 'tasks', component: TasksView, meta: { requiresAuth: true } },
      {
        path: '/activity-types',
        name: 'activity-types',
        component: ActivityTypesView,
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
