import { z } from 'zod';

/**
 * Environment is parsed once, at startup, through a Zod schema — the same
 * single-source-of-validation rule the rest of the app follows (spec §3.1).
 * A misconfigured container fails loudly here rather than on first request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  /**
   * How long the command log is kept, in days (spec §12's "configurable
   * retention"). Unset keeps everything, which is the safe default: undo reads
   * the same log, so a retention window is also a limit on how far back a
   * mistake can be taken (see `pruneAudit`).
   */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  /** Comma-separated list of allowed origins; empty means same-origin only. */
  CORS_ORIGINS: z.string().default(''),

  /**
   * Signing key for session cookies and tokens (spec §10.1).
   *
   * No default, in any environment. A default secret is a published secret, and
   * one that works in development is the one that ends up in production.
   * 32 bytes because that is what the underlying HMAC wants; shorter is
   * accepted by the library and weaker than it looks.
   */
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),

  /**
   * Public origin the app is reached at; cookie domain and callback URLs.
   *
   * **Better Auth decides whether the session cookie is `Secure` from this
   * scheme.** A production deployment that never set it kept the development
   * default, and issued session cookies with no `Secure` attribute — which a
   * browser will then send over plain HTTP, to anyone positioned to read it.
   * The check below refuses that combination at startup rather than serving it.
   */
  BETTER_AUTH_URL: z.url().default('http://localhost:8080'),

  /**
   * Whether an unverified address may sign in (spec §10.1).
   *
   * Off by default because the email transport is a logging adapter until a
   * deployment configures one, and requiring verification without a way to
   * deliver it is an install nobody can sign in to. See `createAuth`.
   */
  REQUIRE_EMAIL_VERIFICATION: z.stringbool().default(false),
});

/**
 * The one cross-field rule: a production origin must be HTTPS.
 *
 * Kept as a refinement rather than folded into `BETTER_AUTH_URL` because the
 * requirement is about `NODE_ENV`, and a schema that demanded HTTPS everywhere
 * would make `docker compose up` fail on a laptop for no benefit.
 *
 * A deployment genuinely terminating TLS elsewhere and reaching this over plain
 * HTTP internally should still set the **public** origin here — that is what
 * the value means, and what the cookie and the callback links have to match.
 */
const productionSchema = envSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  if (env.BETTER_AUTH_URL.startsWith('https://')) return;

  ctx.addIssue({
    code: 'custom',
    path: ['BETTER_AUTH_URL'],
    message:
      'must be an https:// origin in production — Better Auth derives the session ' +
      'cookie’s Secure attribute from it, and an http:// origin ships sessions ' +
      'that browsers will send in the clear',
  });
});

export type Env = z.infer<typeof envSchema> & { corsOrigins: string[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = productionSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}
