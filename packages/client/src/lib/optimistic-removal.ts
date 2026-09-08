import { ref, type Ref } from 'vue';

/**
 * Removing a row before the server has agreed.
 *
 * A delete here is a command, a re-derive and a re-read — a few hundred
 * milliseconds in which the row sits there looking untouched, so the click
 * reads as having done nothing and gets made again. Hiding it at once makes the
 * list feel like a list rather than a form.
 *
 * **Optimistic, not assumed.** The row comes back if the command is refused,
 * which is a real case rather than a theoretical one: deleting an activity type
 * still in use is refused by the server on purpose, and that refusal has to be
 * visible. Restoring it beside the error message is what makes the two add up.
 *
 * Deliberately *not* an optimistic edit. A rename is a value somebody typed and
 * is already on screen; only removal has a gap between the click and the row
 * going, because only removal changes what the list contains.
 */
export interface OptimisticRemoval {
  /** Whether this row should be treated as gone. */
  isRemoved: (id: string) => boolean;
  /** Hides the row, runs `remove`, and puts it back if that came to nothing. */
  removing: (id: string, remove: () => Promise<boolean>) => Promise<void>;
  /** The ids currently hidden, for a caller that needs to filter a list. */
  removed: Ref<ReadonlySet<string>>;
}

export function useOptimisticRemoval(): OptimisticRemoval {
  const removed = ref<ReadonlySet<string>>(new Set());

  const isRemoved = (id: string): boolean => removed.value.has(id);

  async function removing(id: string, remove: () => Promise<boolean>): Promise<void> {
    removed.value = new Set([...removed.value, id]);

    let applied = false;
    try {
      applied = await remove();
    } finally {
      // Cleared either way: on success the row is gone from the data too, and
      // keeping the id would leak a set that only ever grows.
      const next = new Set(removed.value);
      next.delete(id);
      removed.value = next;
      void applied;
    }
  }

  return { isRemoved, removing, removed };
}
