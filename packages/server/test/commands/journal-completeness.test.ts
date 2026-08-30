import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const commandsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../src/commands');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Reversibility has to be a property of the mechanism, not of everyone
 * remembering (spec §12).
 *
 * A handler that writes to a source table directly would work perfectly, pass
 * its own tests, and leave undo silently lossy — the worst failure shape there
 * is, because it only shows up when a user reaches for the thing that is meant
 * to save them. So the rule is that every source write in the command layer
 * goes through `journal.ts`, and this is the test that says so. It is the same
 * argument as the scheduler's purity test: enforce the invariant where it can
 * be seen, rather than trusting that nobody will be in a hurry one day.
 */
describe('every source write in the command layer is journalled', () => {
  /** `journal.ts` *is* the mechanism, and undo has to write without recording. */
  const EXEMPT = new Set(['journal.ts']);

  it('leaves no handler writing to a source table directly', () => {
    const write = /\btx\s*\n?\s*\.(insert|update|delete)\s*\(/;

    const offenders = sourceFiles(commandsRoot)
      .filter((file) => !EXEMPT.has(relative(commandsRoot, file)))
      .filter((file) => write.test(readFileSync(file, 'utf8')))
      .map((file) => relative(commandsRoot, file));

    // `apply.ts` writes the log itself, which is append-only and not source
    // state — nothing reverses a fact about what was intended.
    //
    // `handlers/appointments.ts` tells the other participants of an internal
    // appointment that it moved (§7.2). Undo restores your state, not somebody
    // else's knowledge: by the time you take a move back they may have read the
    // notice or been emailed it, and withdrawing the row would leave them
    // remembering a message the system denies sending.
    expect(offenders).toEqual(['apply.ts', 'handlers/appointments.ts']);
  });

  it('does not smuggle a write through raw SQL either', () => {
    const rawWrite = /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;

    const offenders = sourceFiles(commandsRoot)
      .filter((file) => rawWrite.test(readFileSync(file, 'utf8')))
      .map((file) => relative(commandsRoot, file));

    expect(offenders).toEqual([]);
  });
});
