import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATEGORY_COLORS } from '@ambitime/shared';
import { categories } from '../../src/db/schema/index.js';
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
      tx.select({ color: categories.color }).from(categories).where(eq(categories.id, id)).limit(1),
    );
    return row?.color ?? null;
  };

  const create = async (name: string, color?: string): Promise<string> => {
    const outcome = await world.run({
      type: 'CreateCategory',
      params: { name, ...(color === undefined ? {} : { color }) },
    } as never);
    return outcome.created.find((row) => row.entity === 'category')!.id;
  };

  it('assigns slots in order, so nobody has to choose', async () => {
    // The fixture's own category is inserted directly and has no colour, which
    // is also what every category looked like before this existed — so the
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
      type: 'EditCategory',
      params: { categoryId: first, patch: { color: 'red' } },
    } as never);

    expect(await colourOf(await create('Errands'))).toBe('blue');
  });

  it('runs out rather than cycling', async () => {
    // Two types the same colour claims a relationship that is not there.
    for (let index = 0; index < CATEGORY_COLORS.length; index += 1) {
      await create(`Type ${index}`);
    }

    expect(await colourOf(await create('One too many'))).toBeNull();
  });

  it('lets a colour be cleared, which is not the same as leaving it alone', async () => {
    const id = await create('Exercise');
    await world.run({
      type: 'EditCategory',
      params: { categoryId: id, patch: { color: null } },
    } as never);

    expect(await colourOf(id)).toBeNull();
  });

  it('refuses a value that is not a palette slot', async () => {
    // Belt and braces: the command schema rejects it, and the CHECK constraint
    // would too. A colour the client cannot resolve renders as nothing.
    await expect(create('Nope', '#ff00ff')).rejects.toThrow();
  });
});
