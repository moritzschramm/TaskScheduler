/**
 * Can the server's module graph actually load?
 *
 * `pnpm test` said yes for two milestones while `docker compose up` said no.
 * Vitest resolves through Vite, which smooths CommonJS interop away, so
 * `import { rrulestr } from 'rrule'` — a named import from a CJS package that
 * Node's ESM loader cannot analyse statically — type-checked, passed every
 * test, and threw the instant a real process started.
 *
 * Nothing else in the pipeline runs the server: `build` does not bundle it
 * (tsx runs the sources) and `test` runs under Vite. This is the missing check,
 * and it is deliberately the cheapest one that would have caught it — import
 * the graph under plain Node and look at what comes back. No database, no port,
 * no fixtures, because module resolution fails at import time or not at all.
 */
const entrypoints = [
  '../src/app.js',
  '../src/jobs/queue.js',
  '../src/schedule/recurrence.js',
  '../src/notifications/deliver.js',
  '../src/commands/index.js',
];

/** The failures that mean "this cannot run", as opposed to "this needs a database". */
const RESOLUTION_FAILURE = /does not provide an export|Cannot find (module|package)|ERR_MODULE/;

let failed = false;

for (const entrypoint of entrypoints) {
  try {
    await import(entrypoint);
    console.warn(`ok   ${entrypoint}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (RESOLUTION_FAILURE.test(message)) {
      console.error(`FAIL ${entrypoint}\n     ${message}`);
      failed = true;
      continue;
    }

    // Resolved, then failed on configuration or a socket — which is not what
    // this is looking for, and is the expected outcome without an environment.
    console.warn(`ok   ${entrypoint} (loaded; ${message.split('\n')[0]})`);
  }
}

process.exit(failed ? 1 : 0);
