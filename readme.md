# Ambitime (name is WIP)

A mix between a todo and calendar app. Creates tasks from todos by inserting them into the calendar
while avoiding conflicts with existing entries. A task is scheduled in a predefined timespan.

- **DISCLAIMER** this project was fully implemented using Claude Code
- [`specification.md`](./specification.md): the source of truth for what is being built.

## Quick start

```sh
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:8080>

## Layout

```
packages/
  shared/     Zod schemas + types, imported by both client and server
  scheduler/  the scheduling engine (a pure package: no DB, no HTTP, no clock)
  server/     Hono API + Drizzle
  client/     Vue 3 + Tailwind + Reka UI / shadcn-vue
docker/
  node/       dev and multi-stage prod images
  nginx/      reverse-proxy config (dev proxies Vite; prod serves the built bundle)
```

Everything is served through nginx on one origin: `/api/*` goes to the server, everything else to
the client. There is no cross-origin configuration in either environment.

## Commands

| Command            | What it does                                      |
| ------------------ | ------------------------------------------------- |
| `pnpm dev`         | `docker compose up --build`                       |
| `pnpm build`       | Build every package                               |
| `pnpm typecheck`   | Typecheck every package                           |
| `pnpm lint`        | ESLint, warnings treated as errors                |
| `pnpm format`      | Prettier write                                    |
| `pnpm test`        | Vitest across every package                       |
| `pnpm db:generate` | Generate a Drizzle migration from the schema      |
| `pnpm db:migrate`  | Apply pending migrations                          |

Server tests need a real Postgres (`docker compose up -d postgres`). Override the
connection with `TEST_DATABASE_URL` if it is not on `localhost:5432`.

## Production

```sh
docker compose -f docker-compose.prod.yml up --build
```

Requires `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` in the environment.

## Coding Conventions

- TypeScript strict mode
- Zod schemas live in `packages/shared` and are the single source of both
  types and validation
- Intervals are half-open `[start, end)`
- Instants are stored as `timestamptz` (UTC)
- `packages/scheduler` is pure: no DB or HTTP imports, no wall-clock reads, no randomness. Lint
  rules and `packages/scheduler/test/purity.test.ts` both enforce this.
- All writes go through the command layer, nothing else mutates source state.
