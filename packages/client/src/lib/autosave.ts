import { onScopeDispose, ref, type Ref } from 'vue';

/**
 * Saving as you go, instead of a button that says you may.
 *
 * A Save button asks the user to remember something the application already
 * knows: that the field changed. It also creates a state — typed but not saved
 * — that nothing on screen distinguishes from saved, and that navigating away
 * silently discards. Everything here is one command against a server that
 * re-derives immediately (§7.1), so there is nothing a button buys except the
 * chance to forget it.
 *
 * Two properties make it safe to do on every keystroke:
 *
 * **Debounced per key.** Typing "Exercise" is one intent, not eight, and eight
 * commands would be eight rows in the log (§12) and eight re-derives. A key is
 * whatever should coalesce — usually a row id, or a form section.
 *
 * **Serialised per key.** Two saves of the same row must not be in flight
 * together: they carry `expectedVersion` (§5.4), and the second would be
 * refused for a conflict the user did not cause. A save arriving while one is
 * running replaces whatever else was queued and runs after it, so the last
 * thing typed is the last thing sent.
 *
 * Actions are thunks rather than prepared requests for that reason — they are
 * built when they run, so they read the version and the draft as they are at
 * that moment rather than as they were when the key was pressed.
 */

/** Long enough to swallow typing, short enough not to feel like a delay. */
export const AUTOSAVE_DELAY_MS = 600;

export interface Autosave {
  /** Saves once the key has been quiet for the delay. */
  save: (key: string, action: () => Promise<unknown>) => void;
  /** Saves at once — for a discrete act like adding or removing a row. */
  saveNow: (key: string, action: () => Promise<unknown>) => void;
  /** True while anything is in flight, for disabling destructive controls. */
  busy: Ref<boolean>;
  /** True while any key has an edit typed and not yet sent. */
  dirty: Ref<boolean>;
}

export function useAutosave(delayMs = AUTOSAVE_DELAY_MS): Autosave {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const queued = new Map<string, () => Promise<unknown>>();
  const busy = ref(false);
  const dirty = ref(false);

  async function run(key: string, action: () => Promise<unknown>): Promise<void> {
    if (inFlight.has(key)) {
      queued.set(key, action);
      return;
    }

    inFlight.add(key);
    busy.value = true;

    try {
      await action();
    } finally {
      inFlight.delete(key);
      busy.value = inFlight.size > 0;
      dirty.value = timers.size > 0 || queued.size > 0;

      const next = queued.get(key);
      if (next !== undefined) {
        queued.delete(key);
        void run(key, next);
      }
    }
  }

  function save(key: string, action: () => Promise<unknown>): void {
    clearTimeout(timers.get(key));
    dirty.value = true;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void run(key, action);
      }, delayMs),
    );
  }

  function saveNow(key: string, action: () => Promise<unknown>): void {
    clearTimeout(timers.get(key));
    timers.delete(key);
    void run(key, action);
  }

  // A pending save whose component has gone is a save nobody is waiting for,
  // and firing it would write from a form the user has navigated away from.
  onScopeDispose(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });

  return { save, saveNow, busy, dirty };
}
