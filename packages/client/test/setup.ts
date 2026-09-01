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
