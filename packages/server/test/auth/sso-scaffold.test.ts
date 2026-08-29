import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ssoProviders } from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createTestApp, type TestApp } from '../support/auth.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * The enterprise path, **configured but not onboarded** (spec §10.1).
 *
 * The plan asks for the OIDC/SAML config surface to be scaffolded and for no
 * provider to be registered, so what is pinned here is exactly that pair: the
 * routes answer, and the table is empty. Both halves matter — a scaffold that
 * did not respond would be a comment rather than a seam, and a provider
 * registered "for testing" would be an authentication path nobody asked for
 * sitting live in every environment.
 */
describe('the SSO scaffold', () => {
  let handle: DatabaseHandle;
  let app: TestApp;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    app = createTestApp(handle.db);
  });

  it('exposes the provider registration route', async () => {
    // Unauthenticated, so this is a 401 rather than a 404: the endpoint is
    // there and is refusing the caller, which is the distinction under test.
    const response = await app.app.request('/api/auth/sso/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).not.toBe(404);
  });

  it('onboards nobody', async () => {
    await app.signUp({ email: 'ada@example.test' });

    expect(await handle.db.select().from(ssoProviders)).toEqual([]);
  });
});
