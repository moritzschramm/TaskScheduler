import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../src/db/schema/index.js';
import { decrypt, encrypt, hintFor } from '../../src/assistant/secrets.js';
import type { DatabaseHandle } from '../../src/db/client.js';
import { setupTestDatabase } from '../support/database.js';
import { createTestApp, type Signed, type TestApp } from '../support/auth.js';

/**
 * The one secret this application keeps on somebody's behalf (spec §2.2).
 *
 * Two properties are worth holding down, and both are about the key leaving
 * again: it must never come back out of an endpoint, and it must not be
 * readable in the column it is stored in.
 */

const SECRET = 'a-test-secret-long-enough-to-derive-from-0123456789';
const OTHER_SECRET = 'a-different-secret-entirely-9876543210-abcdefghij';

describe('encrypting a provider key', () => {
  it('round-trips', () => {
    expect(decrypt(encrypt('sk-ant-secret-value', SECRET), SECRET)).toBe('sk-ant-secret-value');
  });

  it('produces different bytes each time, for the same key', () => {
    // A fresh nonce per encryption. Without one, two users with the same key
    // would have the same column value, which is a fact worth nobody learning
    // from a database dump.
    expect(encrypt('sk-same', SECRET)).not.toBe(encrypt('sk-same', SECRET));
  });

  it('refuses to open under another secret rather than returning rubbish', () => {
    expect(decrypt(encrypt('sk-ant-secret-value', SECRET), OTHER_SECRET)).toBeNull();
  });

  it('refuses a ciphertext somebody has edited', () => {
    const stored = encrypt('sk-ant-secret-value', SECRET);
    const [iv, tag, body] = stored.split('.');

    expect(decrypt(`${iv}.${tag}.${body?.slice(0, -2)}AA`, SECRET)).toBeNull();
    expect(decrypt('not-a-ciphertext', SECRET)).toBeNull();
  });

  it('shows four characters and hides the rest', () => {
    expect(hintFor('sk-ant-api03-abcdefgh1234')).toBe('1234');
  });
});

describe('the credential routes', () => {
  let handle: DatabaseHandle;
  let testApp: TestApp;
  let session: Signed;

  beforeAll(async () => {
    handle = await setupTestDatabase();
    testApp = createTestApp(handle.db, undefined, SECRET);
    session = await testApp.signUp({ email: `assistant-${Date.now()}@example.test` });
  });

  afterAll(async () => {
    await handle?.close();
  });

  const put = (body: unknown): Promise<Response> =>
    testApp.as(session, '/api/assistant/credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('stores a key and answers with everything but the key', async () => {
    const response = await put({ provider: 'anthropic', apiKey: 'sk-ant-api03-abcdefgh1234' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toEqual({ provider: 'anthropic', model: 'claude-opus-5', hint: '1234' });
    expect(JSON.stringify(body)).not.toContain('abcdefgh');
  });

  it('writes the column as ciphertext, not as the key', async () => {
    await put({ provider: 'anthropic', apiKey: 'sk-ant-api03-plain-text-please-no' });

    const [row] = await handle.db
      .select({ key: users.assistantKey, hint: users.assistantKeyHint })
      .from(users)
      .where(eq(users.id, session.userId));

    expect(row?.key).not.toContain('sk-ant');
    expect(decrypt(row?.key ?? '', SECRET)).toBe('sk-ant-api03-plain-text-please-no');
    expect(row?.hint).toBe('e-no');
  });

  it('never returns the key from the session read either', async () => {
    const response = await testApp.as(session, '/api/me');
    const body = await response.text();

    expect(body).toContain('"hint"');
    expect(body).not.toContain('sk-ant');
  });

  it('takes the provider default model, and an override when given one', async () => {
    const fallback = await put({ provider: 'openai', apiKey: 'sk-openai-key-value' });
    expect(((await fallback.json()) as { model: string }).model).toBe('gpt-5');

    const chosen = await put({
      provider: 'anthropic',
      apiKey: 'sk-ant-key-value',
      model: 'claude-sonnet-5',
    });
    expect(((await chosen.json()) as { model: string }).model).toBe('claude-sonnet-5');
  });

  it('clears all four columns together', async () => {
    const response = await testApp.as(session, '/api/assistant/credentials', { method: 'DELETE' });
    expect(response.status).toBe(200);

    const [row] = await handle.db
      .select({
        provider: users.assistantProvider,
        model: users.assistantModel,
        key: users.assistantKey,
        hint: users.assistantKeyHint,
      })
      .from(users)
      .where(eq(users.id, session.userId));

    // The check constraint added in 0019 makes a half-cleared row impossible,
    // so this is asserting that the route clears rather than that SQL would
    // have stopped it.
    expect(row).toEqual({ provider: null, model: null, key: null, hint: null });
  });

  it('refuses a turn when there is no key to use', async () => {
    const response = await testApp.as(session, '/api/assistant/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        turns: [{ role: 'user', text: 'what is on Thursday?' }],
        snapshot: '',
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('precondition_failed');
    expect(body.error.message).toMatch(/API key/i);
  });

  it('refuses a turn whose stored key will not open', async () => {
    // What a rotated `BETTER_AUTH_SECRET` looks like from the outside: the
    // column is intact, the bytes are not ours, and the answer is to ask for
    // the key again rather than to fail as though something broke.
    await put({ provider: 'anthropic', apiKey: 'sk-ant-key-value' });
    const rotated = createTestApp(handle.db, undefined, OTHER_SECRET);

    const response = await rotated.as(session, '/api/assistant/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: [{ role: 'user', text: 'hello' }], snapshot: '' }),
    });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /enter it again/i,
    );
  });

  it('requires a session', async () => {
    const response = await testApp.app.request('/api/assistant/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: [{ role: 'user', text: 'hello' }], snapshot: '' }),
    });

    expect(response.status).toBe(401);
  });
});
