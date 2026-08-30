import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notifications, users } from '../../src/db/schema/index.js';
import { withSystemPrivileges } from '../../src/db/context.js';
import { dispatchNotifications, recordHeartbeat } from '../../src/notifications/deliver.js';
import { recordingEmailSender } from '../../src/notifications/email.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, seedTask, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * Presence routing (spec §11).
 *
 * "In-app when the user is online; email when offline. Presence: last-seen
 * heartbeat determines online/offline."
 *
 * The interesting property is not that an email is sent — it is that it is
 * sent **once**, and only to somebody who is not looking. Everything else in
 * this system is idempotent by being derived; delivery is the one thing that
 * cannot be, because a second email is a second email.
 */
describe('delivering notifications', () => {
  let handle: DatabaseHandle;
  let world: World;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createWorld(handle);

    // Something worth telling them about: a deadline that cannot be met.
    await seedTask(world, 'Impossible', {
      estimatedDurationMin: 600,
      dueDate: { date: '2026-03-24T08:00:00Z', kind: 'hard' },
    });
  });

  const NOW = new Date('2026-03-23T09:00:00Z');

  const delivered = () =>
    withSystemPrivileges(handle.db, (tx) =>
      tx
        .select({
          channel: notifications.deliveredChannel,
          deliveredAt: notifications.deliveredAt,
        })
        .from(notifications)
        .where(eq(notifications.userId, world.userId)),
    );

  it('emails a user who is not there', async () => {
    const email = recordingEmailSender();

    // No heartbeat at all: nobody has ever been here.
    const result = await dispatchNotifications({ db: world.db, email, now: NOW });

    expect(result.emailed).toBeGreaterThan(0);
    expect(result.inApp).toBe(0);
    expect(email.sent.length).toBe(result.emailed);
    expect((await delivered()).every((row) => row.channel === 'email')).toBe(true);
  });

  it('sends nothing to a user who is looking at the app', async () => {
    await recordHeartbeat(world.db, world.userId, new Date(NOW.getTime() - 30_000));
    const email = recordingEmailSender();

    const result = await dispatchNotifications({ db: world.db, email, now: NOW });

    // In-app delivery is not an action: the notification is already in the
    // table the client reads, so all that happens is recording how it arrived.
    expect(email.sent).toEqual([]);
    expect(result.inApp).toBeGreaterThan(0);
    expect((await delivered()).every((row) => row.channel === 'in_app')).toBe(true);
  });

  it('treats a stale heartbeat as absent', async () => {
    // Ten minutes ago is well past the timeout: the tab may be open, but the
    // person is not.
    await recordHeartbeat(world.db, world.userId, new Date(NOW.getTime() - 10 * 60_000));
    const email = recordingEmailSender();

    await dispatchNotifications({ db: world.db, email, now: NOW });

    expect(email.sent.length).toBeGreaterThan(0);
  });

  it('never sends the same notification twice', async () => {
    const email = recordingEmailSender();

    await dispatchNotifications({ db: world.db, email, now: NOW });
    const first = email.sent.length;
    expect(first).toBeGreaterThan(0);

    // The dispatcher runs every minute. Everything else in this system is safe
    // to repeat because it is derived; this is the one thing that is not, so
    // `delivered_at` is claimed before the send rather than after.
    await dispatchNotifications({ db: world.db, email, now: new Date(NOW.getTime() + 60_000) });
    await dispatchNotifications({ db: world.db, email, now: new Date(NOW.getTime() + 120_000) });

    expect(email.sent.length).toBe(first);
  });

  it('leaves a notification the user has already read alone', async () => {
    await withSystemPrivileges(handle.db, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: NOW.toISOString() })
        .where(eq(notifications.userId, world.userId)),
    );

    const email = recordingEmailSender();
    await dispatchNotifications({ db: world.db, email, now: NOW });

    // They have seen it. Emailing it now would be telling somebody something
    // they told us they already know.
    expect(email.sent).toEqual([]);
  });

  it('says how much attention the message wants, in the subject', async () => {
    const email = recordingEmailSender();
    await dispatchNotifications({ db: world.db, email, now: NOW });

    // §6.5 and §6.7's distinction is worth as much in an inbox as on screen —
    // arguably more, because an inbox has no badge colour. An alert says so;
    // the informational backlog notice beside it does not.
    const subjects = email.sent.map((message) => message.subject);
    expect(subjects.some((subject) => subject.includes('Action needed'))).toBe(true);
    expect(subjects.some((subject) => subject.startsWith('Ambitime — FYI'))).toBe(true);
  });

  it('records the heartbeat on the person, not the session', async () => {
    await recordHeartbeat(world.db, world.userId, NOW);

    const [row] = await withSystemPrivileges(handle.db, (tx) =>
      tx.select({ lastSeenAt: users.lastSeenAt }).from(users).where(eq(users.id, world.userId)),
    );

    // Someone signed in on a laptop and a phone is online once, and should be
    // told once.
    expect(row?.lastSeenAt).not.toBeNull();
  });
});

/**
 * Telling participants an internal appointment moved (spec §7.2, §11).
 */
describe('internal appointment changes', () => {
  let handle: DatabaseHandle;
  let world: World;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    world = await createWorld(handle);
  });

  async function internalAppointment(participantId: string): Promise<string> {
    const created = await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Design review',
        start: '2026-03-24T09:00:00Z',
        end: '2026-03-24T10:00:00Z',
        isInternal: true,
      },
    } as never);

    const appointmentId = created.created.find((row) => row.entity === 'appointment')!.id;

    const { appointmentParticipants } = await import('../../src/db/schema/index.js');
    await withSystemPrivileges(handle.db, (tx) =>
      tx.insert(appointmentParticipants).values([
        { tenantId: world.tenantId, appointmentId, userId: world.userId },
        { tenantId: world.tenantId, appointmentId, userId: participantId },
      ]),
    );

    return appointmentId;
  }

  const changeNotices = (userId: string) =>
    withSystemPrivileges(handle.db, (tx) =>
      tx
        .select({ id: notifications.id, payload: notifications.payload })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.type, 'internal_appointment_change'),
          ),
        ),
    );

  it('notifies the other participants when the time changes', async () => {
    const { registerUser } = await import('../../src/identity/register-user.js');
    const other = await registerUser(world.db, { email: `other-${Date.now()}@example.test` });
    const { addMember } = await import('../support/fixtures.js');
    await addMember(world.db, world.tenantId, other.userId, 'member');

    const appointmentId = await internalAppointment(other.userId);

    await world.run({
      type: 'EditAppointment',
      params: {
        appointmentId,
        patch: {
          interval: { start: '2026-03-24T11:00:00Z', end: '2026-03-24T12:00:00Z' },
        },
      },
    } as never);

    // The counterparty is told; the person who moved it is not, because they
    // were there.
    expect(await changeNotices(other.userId)).toHaveLength(1);
    expect(await changeNotices(world.userId)).toEqual([]);
  });

  it('says nothing for a rename', async () => {
    const { registerUser } = await import('../../src/identity/register-user.js');
    const other = await registerUser(world.db, { email: `other2-${Date.now()}@example.test` });
    const { addMember } = await import('../support/fixtures.js');
    await addMember(world.db, world.tenantId, other.userId, 'member');

    const appointmentId = await internalAppointment(other.userId);

    await world.run({
      type: 'EditAppointment',
      params: { appointmentId, patch: { title: 'Design review (renamed)' } },
    } as never);

    // §7.2 is about a meeting *moving*. A new title is not a change anybody
    // needs to rearrange their day around.
    expect(await changeNotices(other.userId)).toEqual([]);
  });

  it('says nothing for an external appointment', async () => {
    const created = await world.run({
      type: 'AddAppointment',
      params: {
        calendarId: world.calendarId,
        title: 'Dentist',
        start: '2026-03-25T09:00:00Z',
        end: '2026-03-25T10:00:00Z',
      },
    } as never);
    const appointmentId = created.created.find((row) => row.entity === 'appointment')!.id;

    await world.run({
      type: 'EditAppointment',
      params: {
        appointmentId,
        patch: { interval: { start: '2026-03-25T11:00:00Z', end: '2026-03-25T12:00:00Z' } },
      },
    } as never);

    // §7.2 draws the line at whether the system can do anything: an external
    // appointment is the user's to renegotiate, and there is nobody here to
    // tell.
    const all = await withSystemPrivileges(handle.db, (tx) =>
      tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.type, 'internal_appointment_change')),
    );
    expect(all).toEqual([]);
  });
});
