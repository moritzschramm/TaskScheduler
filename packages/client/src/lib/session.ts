import { readonly, ref } from 'vue';
import { api } from './api';

/**
 * Who is signed in, and where they are acting (spec §9.3, §10.1).
 *
 * A module-level singleton rather than a store: there is exactly one session
 * per page, the router guard and the shell both need it, and a state library
 * for one object would be ceremony. If M12's optimistic scheduling needs more
 * shared state than this, that is the moment to reach for Pinia — not now.
 *
 * Nothing here holds a token. The session lives in an HttpOnly cookie the
 * browser attaches on its own (§10.1), which is why signing in is a request
 * whose *body* we discard and whose effect is entirely in the response headers.
 */

export interface SessionContext {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
  isPersonal: boolean;
}

export interface Session {
  user: { id: string; email: string; displayName: string | null };
  activeTenantId: string;
  contexts: SessionContext[];
}

const current = ref<Session | null>(null);
const resolved = ref(false);

export const session = readonly(current);
export const sessionResolved = readonly(resolved);

/**
 * Asks the server who we are.
 *
 * Returns `null` for "not signed in" rather than throwing, because that is not
 * an error — it is the answer, and the router acts on it.
 */
export async function loadSession(): Promise<Session | null> {
  const response = await api.api.me.$get();

  current.value = response.status === 200 ? ((await response.json()) as Session) : null;
  resolved.value = true;

  return current.value;
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const response = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    // Deliberately not the server's wording. "No account with that address"
    // and "wrong password" are the same message here, because distinguishing
    // them tells someone which half they got right.
    return 'Those details did not match an account';
  }

  await loadSession();
  return null;
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
  current.value = null;
}
