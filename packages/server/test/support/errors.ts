/**
 * Drizzle wraps driver errors, so the interesting part — the SQLSTATE — sits on
 * `cause`. Asserting on the code rather than the message keeps these tests from
 * breaking on a Postgres wording change, and states precisely which invariant
 * fired.
 */
export function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

export const SQLSTATE = {
  /** A policy's WITH CHECK rejected the row, or the role lacks the privilege. */
  insufficientPrivilege: '42501',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  /** Raised by our own assertion triggers via `USING ERRCODE = 'check_violation'`. */
  checkViolation: '23514',
} as const;

export async function captureSqlState(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return sqlStateOf(error);
  }
  throw new Error('Expected the statement to be rejected, but it succeeded');
}
