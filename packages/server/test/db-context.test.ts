import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantAccessError, withSystemPrivileges, withTenantContext } from '../src/db/context.js';
import { teams, tenants } from '../src/db/schema/index.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { addMember, createTeam, createWorkTenant, registerUser } from './support/fixtures.js';
import { resetDomainTables, setupTestDatabase } from './support/database.js';

/**
 * Transaction semantics of the two context helpers.
 *
 * Every milestone from M6 onwards writes through `withTenantContext`, so the
 * guarantees asserted here — atomicity, and that a request's context cannot
 * outlive or escape its transaction — are load-bearing for everything after.
 */
describe('database context helpers', () => {
  let handle: DatabaseHandle;

  let alice: string;
  let bob: string;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);

    alice = (await registerUser(handle.db, { email: 'alice@example.com' })).userId;
    bob = (await registerUser(handle.db, { email: 'bob@example.com' })).userId;

    tenantA = await createWorkTenant(handle.db, 'Tenant A');
    tenantB = await createWorkTenant(handle.db, 'Tenant B');
    await addMember(handle.db, tenantA, alice, 'owner');
    await addMember(handle.db, tenantB, bob, 'owner');
  });

  describe('withTenantContext', () => {
    it('returns the callback’s value', async () => {
      const result = await withTenantContext(
        handle.db,
        { userId: alice, tenantId: tenantA },
        async () => 'payload',
      );

      expect(result).toBe('payload');
    });

    it('rolls back everything the callback wrote when it throws', async () => {
      await expect(
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async (tx) => {
          await tx.insert(teams).values({ tenantId: tenantA, name: 'Doomed' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const survivors = await handle.db
        .select({ name: teams.name })
        .from(teams)
        .where(eq(teams.tenantId, tenantA));
      expect(survivors).toEqual([]);
    });

    it('releases the role and context even when the transaction fails', async () => {
      await expect(
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // A rolled-back SET LOCAL unwinds like any other change, so the pooled
      // connection must come back usable and unprivileged-by-nobody.
      const [after] = await handle.db.execute<{ role: string }>(sql`select current_user as role`);
      expect(after?.role).toBe('ambitime');

      const rows = await handle.db.select({ id: tenants.id }).from(tenants);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('rejects an unauthorised context before running the callback at all', async () => {
      const callback = vi.fn();

      await expect(
        withTenantContext(handle.db, { userId: alice, tenantId: tenantB }, callback),
      ).rejects.toThrow(TenantAccessError);

      expect(callback).not.toHaveBeenCalled();
    });

    it('names the user and tenant on the access error', async () => {
      let captured: unknown;
      try {
        await withTenantContext(handle.db, { userId: alice, tenantId: tenantB }, async () => 'ok');
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(TenantAccessError);
      const error = captured as TenantAccessError;
      expect(error.userId).toBe(alice);
      expect(error.tenantId).toBe(tenantB);
    });

    it('checks membership above RLS, not through it', async () => {
      // The membership lookup runs while still the owner. If it ran after the
      // role switch it would be filtered by the very policies it is meant to
      // authorise, and no context would ever validate.
      await expect(
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, async () => 'ok'),
      ).resolves.toBe('ok');
    });

    it('keeps concurrent contexts on separate connections isolated', async () => {
      await createTeam(handle.db, tenantA, 'Team A');
      await createTeam(handle.db, tenantB, 'Team B');

      // The failure mode this guards against is a context leaking across pooled
      // connections; running both at once is what would expose it.
      const [seenByAlice, seenByBob] = await Promise.all([
        withTenantContext(handle.db, { userId: alice, tenantId: tenantA }, (tx) =>
          tx.select({ name: teams.name }).from(teams),
        ),
        withTenantContext(handle.db, { userId: bob, tenantId: tenantB }, (tx) =>
          tx.select({ name: teams.name }).from(teams),
        ),
      ]);

      expect(seenByAlice.map((r) => r.name)).toEqual(['Team A']);
      expect(seenByBob.map((r) => r.name)).toEqual(['Team B']);
    });

    it('does not leak context between sequential requests on a warm pool', async () => {
      await createTeam(handle.db, tenantA, 'Team A');
      await createTeam(handle.db, tenantB, 'Team B');

      for (let i = 0; i < 6; i += 1) {
        const rows = await withTenantContext(
          handle.db,
          i % 2 === 0 ? { userId: alice, tenantId: tenantA } : { userId: bob, tenantId: tenantB },
          (tx) => tx.select({ name: teams.name }).from(teams),
        );

        expect(rows.map((r) => r.name)).toEqual([i % 2 === 0 ? 'Team A' : 'Team B']);
      }
    });
  });

  describe('withSystemPrivileges', () => {
    it('rolls back on failure', async () => {
      await expect(
        withSystemPrivileges(handle.db, async (tx) => {
          await tx.insert(tenants).values({ name: 'Half-created' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const found = await handle.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.name, 'Half-created'));
      expect(found).toEqual([]);
    });

    it('is not filtered by tenant policies', async () => {
      await createTeam(handle.db, tenantA, 'Team A');
      await createTeam(handle.db, tenantB, 'Team B');

      const all = await withSystemPrivileges(handle.db, (tx) =>
        tx.select({ name: teams.name }).from(teams),
      );

      expect(all.map((r) => r.name).sort()).toEqual(['Team A', 'Team B']);
    });
  });
});
