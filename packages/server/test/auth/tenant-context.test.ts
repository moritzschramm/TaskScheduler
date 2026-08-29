import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveRequestContext, withRequestContext } from '../../src/auth/context.js';
import { TenantAccessError, withSystemPrivileges } from '../../src/db/context.js';
import { calendars, memberships, tenants } from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createTestApp, setActiveTenant, type Signed, type TestApp } from '../support/auth.js';
import { captureSqlState, SQLSTATE } from '../support/errors.js';
import { sessions } from '../../src/db/schema/index.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Session → tenant context (spec §5.2, §9, §10.1).
 *
 * The milestone's whole point. Until now `withTenantContext` was handed a
 * `{ userId, tenantId }` that a test made up; the question here is whether the
 * one that comes out of a real signed session reaches RLS intact, and whether
 * changing it changes what the database will show.
 *
 * The strongest assertion in the file is the negative one: a request cannot
 * name its own tenant. There is no header, no parameter and no body field that
 * moves it — the active tenant lives on the session row, and the only thing
 * that writes it checks membership first.
 */
describe('the tenant context behind a request', () => {
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

  const headersFor = (session: Signed) => new Headers({ cookie: session.cookie });

  const contextOf = (session: Signed) =>
    resolveRequestContext(app.auth, handle.db, headersFor(session));

  /** A calendar named after its tenant, so a leak is legible in the assertion. */
  async function seedCalendar(tenantId: string, ownerId: string, name: string): Promise<void> {
    await withSystemPrivileges(handle.db, (tx) =>
      tx.insert(calendars).values({ tenantId, ownerId, name, timezone: 'Europe/Berlin' }),
    );
  }

  async function createTenantFor(session: Signed, name: string, slug: string): Promise<string> {
    const response = await app.app.request('/api/auth/organization/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      body: JSON.stringify({ name, slug }),
    });

    if (!response.ok) throw new Error(`Could not create ${name}: ${await response.text()}`);
    return ((await response.json()) as { id: string }).id;
  }

  it('starts a session in the personal tenant', async () => {
    const session = await app.signUp({ email: 'ada@example.test' });
    const context = await contextOf(session);

    const [personal] = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.personalOwnerId, session.userId));

    expect(context).toMatchObject({ userId: session.userId, tenantId: personal!.id });
  });

  it('reports the active context and everything to switch between', async () => {
    const session = await app.signUp({ email: 'ada@example.test' });
    await createTenantFor(session, 'Acme', 'acme');

    const body = (await (await app.as(session, '/api/me')).json()) as {
      activeTenantId: string;
      contexts: { slug: string; role: string; isPersonal: boolean }[];
    };

    expect(body.contexts).toHaveLength(2);
    expect(body.contexts.filter((row) => row.isPersonal)).toHaveLength(1);
    expect(body.contexts.map((row) => row.role)).toEqual(['owner', 'owner']);
  });

  it('shows only the active tenant data, and shows the other after a switch', async () => {
    const session = await app.signUp({ email: 'ada@example.test' });
    const [personal] = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.personalOwnerId, session.userId));
    const acmeId = await createTenantFor(session, 'Acme', 'acme');

    await seedCalendar(personal!.id, session.userId, 'Private');
    await seedCalendar(acmeId, session.userId, 'Work');

    const visibleNow = async () =>
      withRequestContext(handle.db, await contextOf(session), (tx) =>
        tx.select({ name: calendars.name }).from(calendars),
      );

    // Creating an organization makes it active, so the switch below is a real
    // move back rather than a no-op.
    expect(await visibleNow()).toEqual([{ name: 'Work' }]);

    const switched = await setActiveTenant(app, session, personal!.id);
    expect(switched.ok).toBe(true);

    expect(await visibleNow()).toEqual([{ name: 'Private' }]);
  });

  it('will not make a tenant active that the user does not belong to', async () => {
    const ada = await app.signUp({ email: 'ada@example.test' });
    const grace = await app.signUp({ email: 'grace@example.test' });
    const graceTenant = await createTenantFor(grace, 'Hopper', 'hopper');

    const response = await setActiveTenant(app, ada, graceTenant);

    expect(response.ok).toBe(false);
    // And the refusal is not merely cosmetic: her context did not move.
    const [adaPersonal] = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.personalOwnerId, ada.userId));
    expect((await contextOf(ada)).tenantId).toBe(adaPersonal!.id);
  });

  it('stops honouring a context once the membership is revoked', async () => {
    // The session is still valid and still names the tenant. What changed is
    // the membership, which is why `withTenantContext` re-checks it per request
    // rather than trusting the check made when the context was set.
    const session = await app.signUp({ email: 'ada@example.test' });
    const acmeId = await createTenantFor(session, 'Acme', 'acme');

    await withSystemPrivileges(handle.db, (tx) =>
      tx.delete(memberships).where(eq(memberships.tenantId, acmeId)),
    );

    const context = await contextOf(session);
    expect(context.tenantId).toBe(acmeId);

    await expect(
      withRequestContext(handle.db, context, (tx) => tx.select().from(calendars)),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it('will not let a request read the session table it was authenticated by', async () => {
    // The one table where "filtered to the right rows" is the wrong answer. A
    // live session token readable through any tenant-scoped request would let
    // one member of a shared tenant become another; migration 0005 revokes the
    // grant outright, and RLS with no policy sits behind that.
    const session = await app.signUp({ email: 'ada@example.test' });
    const context = await contextOf(session);

    const state = await captureSqlState(() =>
      withRequestContext(handle.db, context, (tx) =>
        tx.select({ token: sessions.token }).from(sessions),
      ),
    );

    expect(state).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('gives two people in one tenant the same data and different identities', async () => {
    const ada = await app.signUp({ email: 'ada@example.test' });
    const acmeId = await createTenantFor(ada, 'Acme', 'acme');
    const grace = await app.signUp({ email: 'grace@example.test' });

    await withSystemPrivileges(handle.db, (tx) =>
      tx.insert(memberships).values({ tenantId: acmeId, userId: grace.userId, role: 'member' }),
    );
    await setActiveTenant(app, grace, acmeId);
    await seedCalendar(acmeId, ada.userId, 'Shared');

    const seenBy = async (session: Signed) =>
      withRequestContext(handle.db, await contextOf(session), (tx) =>
        tx.select({ name: calendars.name }).from(calendars),
      );

    expect(await seenBy(ada)).toEqual([{ name: 'Shared' }]);
    expect(await seenBy(grace)).toEqual([{ name: 'Shared' }]);
    expect((await contextOf(ada)).userId).not.toBe((await contextOf(grace)).userId);
  });
});
