import { hc } from 'hono/client';
import type { AppType } from '@ambitime/server';

/**
 * Typed RPC client over the Hono app (spec §3.1: one typed client/server
 * contract). `@ambitime/server` is a type-only dependency — nothing from the
 * server's runtime is bundled into the client.
 *
 * Requests go to the same origin: nginx proxies `/api` to the server in both
 * dev and prod, so there is no cross-origin configuration to keep in sync.
 */
export const api = hc<AppType>('/');

/** A refusal from the API, carrying the sentence the server wrote for a person. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The parsed body of a successful response, or a thrown `ApiError`.
 *
 * The message is the server's own: the command layer phrases its refusals for
 * the person who will read them — "A category called Work already exists" — and
 * replacing that with a generic string at this boundary would throw away the
 * only part of the failure a user can act on (§6.7).
 */
export async function expectOk(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.ok) return body;

  const message =
    typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: { message?: string } }).error.message ?? response.statusText)
      : response.statusText;

  throw new ApiError(response.status, message);
}
