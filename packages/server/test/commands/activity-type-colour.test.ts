import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_TYPE_COLORS } from '@ambitime/shared';
import { activityTypes } from '../../src/db/schema/index.js';
import { resetDomainTables, setupTestDatabase } from '../support/database.js';
import { createWorld, type World } from '../support/world.js';
import type { DatabaseHandle } from '../../src/db/client.js';

/**
 * A colour per activity type (spec §4.3).
 *
 * The interesting behaviour is not that the column stores a string — it is that
 * a user who never opens the picker still gets colours that are told apart, and
 * that the ones stored are always slots the client can resolve.
 */
describe('activity type colours', () => {
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

  const colourOf = async (id: string): Promise<string | null> => {
    const [row] = await world.read((tx) =>
      tx
        .select({ color: activityTypes.color })
        .from(activityTypes)
        .where(eq(activityTypes.id, id))
        .limit(1),
    );
    return row?.color ?? null;
  };

  const create = async (name: string, color?: string): Promise<string> => {
    const outcome = await world.run({
      type: 'CreateActivityType',
      params: { name, ...(color === undefined ? {} : { color }) },
    } as never);
    return outcome.created.find((row) => row.entity === 'activity_type')!.id;
  };

  it('assigns slots in order, so nobody has to choose', async () => {
    // The fixture's own activity type is inserted directly and has no colour, which
    // is also what every activity type looked like before this existed — so the
    // first one created through the command takes the first slot, and a
    // colourless row is skipped rather than counted.
    const first = await create('Exercise');
    const second = await create('Errands');

    expect(await colourOf(first)).toBe('blue');
    expect(await colourOf(second)).toBe('orange');
  });

  it('honours a colour the user picked', async () => {
    expect(await colourOf(await create('Reading', 'violet'))).toBe('violet');
  });

  it('fills a gap rather than counting past it', async () => {
    // Somebody recolours the first type; the next one takes what it freed
    // rather than carrying on from where the count had reached.
    const first = await create('Exercise');
    await world.run({
      type: 'EditActivityType',
      params: { activityTypeId: first, patch: { color: 'red' } },
    } as never);

    expect(await colourOf(await create('Errands'))).toBe('blue');
  });

  it('starts round again rather than running out', async () => {
    // A ninth type shares blue with the first. The alternative was no colour,
    // which puts that type's hours on the grid as a grey lane — and grey is
    // what unavailable time looks like everywhere else (§4.3).
    for (let index = 0; index < ACTIVITY_TYPE_COLORS.length; index += 1) {
      await create(`Type ${index}`);
    }

    expect(await colourOf(await create('One too many'))).toBe('blue');
    expect(await colourOf(await create('And another'))).toBe('orange');
  });

  it('still lets a colour be cleared, for an undo to be able to put one back', async () => {
    // Nothing in the UI asks for this any more (migration 0018). The command
    // keeps it because §12's undo restores row images, and an image written
    // before every type had a colour can carry a null.
    const id = await create('Exercise');
    await world.run({
      type: 'EditActivityType',
      params: { activityTypeId: id, patch: { color: null } },
    } as never);

    expect(await colourOf(id)).toBeNull();
  });

  it('refuses a value that is not a palette slot', async () => {
    // Belt and braces: the command schema rejects it, and the CHECK constraint
    // would too. A colour the client cannot resolve renders as nothing.
    await expect(create('Nope', '#ff00ff')).rejects.toThrow();
  });
});
