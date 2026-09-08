import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { MINIMUM_PASSWORD_LENGTH } from '@ambitime/shared';

/**
 * Configuration that is only wrong in production (spec §10.1, §14).
 *
 * These are the settings whose default is right on a laptop and dangerous on a
 * server, which is the shape of misconfiguration nobody notices: everything
 * works, and the thing that was supposed to protect the session is absent.
 */
describe('environment refuses an unsafe production origin', () => {
  const base = {
    DATABASE_URL: 'postgres://user:pw@localhost:5432/db',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
  };

  it('rejects an http origin in production', () => {
    // Better Auth reads the scheme to decide whether the session cookie is
    // `Secure`; http here means sessions a browser will send in the clear.
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', BETTER_AUTH_URL: 'http://ambitime.example' }),
    ).toThrow(/https/);
  });

  it('rejects the development default reaching production unchanged', () => {
    // The failure mode being guarded: nobody set it, so it kept the value that
    // works on a laptop.
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/BETTER_AUTH_URL/);
  });

  it('accepts an https origin in production', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'https://ambitime.example',
    });

    expect(env.BETTER_AUTH_URL).toBe('https://ambitime.example');
  });

  it('leaves development alone', () => {
    // A schema that demanded https everywhere would break `docker compose up`
    // for no benefit — the rule is about production, not about the scheme.
    expect(loadEnv(base).BETTER_AUTH_URL).toBe('http://localhost:8080');
  });

  it('still requires a secret long enough to be one', () => {
    expect(() => loadEnv({ ...base, BETTER_AUTH_SECRET: 'too-short' })).toThrow(/32 characters/);
  });
});

describe('the password policy', () => {
  it('is a number the server owns', () => {
    // The sign-up form states this length. It used to be the client's own
    // constant agreeing with the library's default by coincidence.
    expect(MINIMUM_PASSWORD_LENGTH).toBe(8);
  });
});
