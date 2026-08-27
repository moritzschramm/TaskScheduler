import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Workspace packages are consumed from TypeScript source (see their `exports`),
 * so they must be bundled in — node cannot load them otherwise. Third-party
 * deps stay external and are installed normally in the runtime image, which
 * keeps the bundle small and avoids fighting drizzle's optional-driver requires.
 */
const external = Object.keys(pkg.dependencies ?? {}).filter((dep) => !dep.startsWith('@ambitime/'));

await build({
  // `migrate` is a separate entry so the production image can run migrations
  // without shipping the TypeScript toolchain.
  entryPoints: ['src/index.ts', 'src/db/migrate.ts'],
  outdir: 'dist',
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external,
  logLevel: 'info',
  banner: {
    // Some CJS deps reach for `require` when bundled into ESM.
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});
