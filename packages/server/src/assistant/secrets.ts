import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encryption for the one secret this application holds on somebody's behalf.
 *
 * **What this protects against.** A database dump — a backup on a laptop, a
 * restored snapshot, a `SELECT *` by somebody with read access to the tables
 * and nothing else. In all of those the column is opaque, because the key that
 * opens it is in the server's environment and not in the database.
 *
 * **What it does not.** A compromised server reads the environment, so it reads
 * every key. That is not a gap this could close: the server has to be able to
 * *send* the credential to Anthropic or OpenAI, which means it has to be able
 * to recover the plaintext, which means anything holding the server's secrets
 * can too. What is worth having is the separation — two different things must
 * leak, not one — and that is what this buys.
 *
 * Derived from `BETTER_AUTH_SECRET` via HKDF with a fixed, labelled salt rather
 * than used directly. One secret, several purposes, and a key that is never the
 * same bytes as the one signing session cookies; rotating the environment
 * variable invalidates stored credentials, which is the correct consequence of
 * rotating a master secret and is what `decrypt` returning `null` means.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INFO = 'ambitime:assistant-credentials:v1';

/** Derived per call rather than cached: `loadEnv` is the only source of truth. */
function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), INFO, '', KEY_BYTES));
}

/**
 * `iv.tag.ciphertext`, base64url.
 *
 * Three parts in one column because they are one value: a ciphertext without
 * its nonce and tag is not a shorter secret, it is an unopenable one, and three
 * columns would be three chances for a migration to separate them.
 */
export function encrypt(plaintext: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

/**
 * The plaintext, or `null` if this ciphertext is not ours to open.
 *
 * `null` rather than a thrown error, because every way of reaching it is a
 * configuration fact rather than a bug: the secret was rotated, the row was
 * restored from another deployment, the column was hand-edited. The caller's
 * answer to all three is the same — ask the user for the key again — and it is
 * a better answer than a 500.
 */
export function decrypt(stored: string, secret: string): string | null {
  const parts = stored.split('.');
  if (parts.length !== 3) return null;

  const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv === undefined || tag === undefined || body === undefined) return null;
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

  try {
    const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // GCM authentication failed: wrong key, or the bytes were changed.
    return null;
  }
}

/**
 * The last four characters, which is all anybody is shown.
 *
 * Providers print keys that way themselves, and four characters is enough to
 * answer the only question a settings screen is asked — "is that the key I
 * think it is?" — without being enough to be worth stealing.
 */
export function hintFor(apiKey: string): string {
  return apiKey.slice(-4).padStart(4, '•');
}
