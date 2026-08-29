import { Hono } from 'hono';
import { resolveRequestContext, UnauthenticatedError } from './context.js';
import type { AppEnv } from '../app.js';
import type { Auth } from './auth.js';
import type { MiddlewareHandler } from 'hono';

/**
 * Mounting Better Auth, and the middleware that turns its session into the
 * context every other route runs under (spec §10.1).
 */

/**
 * Better Auth's own endpoints: sign-up, sign-in, sign-out, session, and the
 * organization and SSO routes its plugins add.
 *
 * Handed the raw `Request` rather than anything Hono has reshaped, because the
 * library reads and writes cookies itself and is the authority on their
 * attributes — `Secure`, `SameSite`, `HttpOnly`, expiry. An adapter that
 * repackaged them would be a second opinion on the one part of this that must
 * not have two.
 */
export function authRoutes(auth: Auth) {
  // `/auth/*`, not `/api/auth/*`: the app this is mounted into already carries
  // the `/api` base path. Better Auth's own `basePath` is the *external* URL it
  // sees on the request, and that one does include it.
  return new Hono<AppEnv>().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));
}

/**
 * Requires a signed-in session and attaches the context its queries run under.
 *
 * A 401 here means "no usable session", which covers no cookie, an expired one,
 * and a valid one whose user has somehow no tenant. The three are deliberately
 * not distinguished in the response: telling an unauthenticated caller *why*
 * their credential failed is telling them how to get closer.
 */
export function requireContext(auth: Auth): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      c.set('context', await resolveRequestContext(auth, c.get('db'), c.req.raw.headers));
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) throw error;
      return c.json({ error: { code: 'unauthenticated', message: 'Not signed in' } }, 401);
    }

    await next();
    return;
  };
}
