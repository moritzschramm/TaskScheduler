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

  /** Public origin the app is reached at; cookie domain and callback URLs. */
  BETTER_AUTH_URL: z.url().default('http://localhost:8080'),
});

export type Env = z.infer<typeof envSchema> & { corsOrigins: string[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

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
