import { createApp } from '../../src/app.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import type { Database } from '../../src/db/client.js';

/**
 * A real Better Auth instance over the test database.
 *
 * Not a stub. Everything M8 claims — that sign-up creates a personal tenant,
 * that a session becomes a tenant context, that switching context changes what
 * RLS lets through — is a claim about what the library and the database do
 * together, and a fake of either would assert nothing.
 */

/** Long enough for the secret's own validation; not a secret in any real sense. */
export const TEST_AUTH_SECRET = 'test-secret-not-for-any-real-deployment-0123456789';

export const TEST_BASE_URL = 'http://localhost';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  auth: Auth;
  /** Signs up a new user and returns their session cookie. */
  signUp: (input: SignUpInput) => Promise<Signed>;
  signIn: (input: { email: string; password: string }) => Promise<Signed>;
  /** Issues a request carrying a session cookie. */
  as: (session: Signed, path: string, init?: RequestInit) => Promise<Response>;
}

export interface SignUpInput {
  email: string;
  password?: string;
  name?: string;
}

export interface Signed {
  cookie: string;
  userId: string;
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export function createTestApp(db: Database): TestApp {
  const auth = createAuth({ db, secret: TEST_AUTH_SECRET, baseURL: TEST_BASE_URL });
  const app = createApp({ db, auth, requestLogging: false });

  const post = async (path: string, body: unknown, cookie?: string): Promise<Response> =>
    await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    });

  const collect = async (response: Response): Promise<Signed> => {
    if (!response.ok) {
      throw new Error(`Auth request failed: ${response.status} ${await response.text()}`);
    }

    // `getSetCookie` keeps the cookies separate, which a joined `set-cookie`
    // header would not: session tokens contain commas.
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');

    const body = (await response.json()) as { user?: { id?: string } };
    return { cookie, userId: body.user?.id ?? '' };
  };

  return {
    app,
    auth,

    signUp: (input) =>
      post('/api/auth/sign-up/email', {
        email: input.email,
        password: input.password ?? TEST_PASSWORD,
        name: input.name ?? input.email,
      }).then(collect),

    signIn: (input) => post('/api/auth/sign-in/email', input).then(collect),

    as: async (session, path, init = {}) =>
      app.request(path, {
        ...init,
        headers: { ...(init.headers ?? {}), cookie: session.cookie },
      }),
  };
}

/** Switches a session's active tenant through Better Auth's own endpoint. */
export async function setActiveTenant(
  testApp: TestApp,
  session: Signed,
  tenantId: string,
): Promise<Response> {
  return testApp.app.request('/api/auth/organization/set-active', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie },
    body: JSON.stringify({ organizationId: tenantId }),
  });
}
