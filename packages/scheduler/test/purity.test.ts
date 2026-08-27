import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Operating-brief rule #5 and spec §3.3: the scheduler stays pure so it can run
 * identically on client and server. Lint enforces this while editing; this test
 * enforces it in CI, where a lint-disable comment would otherwise slip through.
 */
describe('scheduler package purity', () => {
  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('imports no infrastructure or Node built-ins', () => {
    const forbidden =
      /from\s+['"](node:|fs|path|http|https|drizzle-orm|postgres|pg|hono|@ambitime\/server)/;

    const offenders = sourceFiles(join(packageRoot, 'src')).filter((file) =>
      forbidden.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('reads neither the wall clock nor a random source', () => {
    const forbidden = /\bDate\.now\(|new Date\(|Math\.random\(|performance\.now\(/;

    const offenders = sourceFiles(join(packageRoot, 'src')).filter((file) =>
      forbidden.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});
