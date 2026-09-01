/**
 * One repair to the jsdom environment, before any test runs.
 *
 * **jsdom's globals come from a separate V8 realm, and typed arrays do not
 * cross it.** Vitest builds the test global scope by copying jsdom's `window`
 * — a `vm` context — so `Uint8Array` here is that context's, while everything
 * running as ordinary Node code (jsdom's own library, `TextEncoder`, anything
 * in `node_modules`) uses Node's. The two constructors are not the same object,
 * so `instanceof` between them is false.
 *
 * That is invisible until something checks. `jose`, which Better Auth signs
 * email-verification tokens with, checks — and rejects a key made by
 * `TextEncoder` with the memorable complaint that it "must be one of type
 * CryptoKey, KeyObject, JSON Web Key, or Uint8Array. Received an instance of
 * Uint8Array." So the e2e suite could not sign up a user, while the server it
 * was testing could: the real one runs in Node with one realm and never sees
 * this.
 *
 * Putting Node's back is a correction rather than a workaround. Vitest runs
 * jsdom with scripting disabled, so nothing actually executes *inside* that
 * realm — the vm context's constructors are reachable by the test file and used
 * by nothing else.
 */
const nodeRealmTypedArray = new TextEncoder().encode('').constructor as Uint8ArrayConstructor;

globalThis.Uint8Array = nodeRealmTypedArray;

/**
 * jsdom has no `ResizeObserver`, and Reka's slider measures its own track.
 *
 * A no-op is the honest stub: jsdom does no layout, so every box it could
 * report would be zero anyway. What the tests assert about the slider is its
 * value and its labels, neither of which depends on a measurement.
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

/**
 * jsdom 30 exposes no `localStorage`, even on a real origin.
 *
 * The application already treats it as absent-or-throwing — private browsing
 * and disabled storage are ordinary — so production is fine without one. What
 * a stub buys is the ability to *test* that a preference survives, which is the
 * whole point of storing it.
 */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

globalThis.localStorage ??= new MemoryStorage();
