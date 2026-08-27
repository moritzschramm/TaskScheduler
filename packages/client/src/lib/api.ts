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
