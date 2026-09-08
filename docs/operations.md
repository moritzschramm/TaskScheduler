# Operating Ambitime

The hardening baselines of spec §14, and what backing this up actually means.
Written for whoever has to run it at three in the morning, so it says what is
true rather than what would be reassuring.

## What the data is worth

Two things in this database cannot be recomputed:

- **Source state** — tasks, appointments, calendars, categories, windows,
  settings. Everything a person typed.
- **The command log** — the append-only record of what was done, and the row
  images that make undo possible (§12).

Everything else is derived and would come back on its own:

- `placements` is a cache; the next read re-derives it (§3.4).
- `notifications` for a standing signal are recomputed from the next solve
  (§11) — but a _delivered_ one is not, and `delivered_at` is the only record
  that an email was sent. Losing it means sending it again.
- `task_occurrences` for future periods respawn from the recurrence rule
  (§8.2); completed ones are history and do not.

So a backup that captured only the source tables would lose the audit trail and
resend yesterday's email. Back up the whole database.

## Backups

### Continuous archiving, not only dumps

`pg_dump` on a schedule gives a recovery point as old as the last dump. For a
calendar that is a working day's worth of decisions. Configure WAL archiving so
recovery is to a point in time:

```
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'
archive_timeout = 300          # a segment at least every 5 minutes
```

Take a base backup weekly and keep the WAL between them:

```sh
pg_basebackup --pgdata=/backup/base-$(date +%F) --format=tar --gzip \
  --wal-method=stream --checkpoint=fast --progress
```

`archive_timeout` is the real recovery-point objective: five minutes of writes
is the most that can be lost, and lowering it costs segments rather than
performance.

### Also take a logical dump

A physical backup restores to the same major version and the same architecture.
A logical one survives an upgrade and can be read by a human:

```sh
pg_dump --format=custom --compress=9 --file=/backup/ambitime-$(date +%F).dump ambitime
```

Weekly is enough, because the WAL covers the gaps.

### Verify by restoring

An unverified backup is a belief, not a backup. Monthly, restore the most recent
base backup plus WAL into a scratch instance and check three things:

```sh
# 1. Migrations are where they should be.
psql -c "select value from app_meta where key = 'schema_version'"

# 2. The log is intact — this is what undo and audit both read.
psql -c "select count(*), min(seq), max(seq) from commands"

# 3. RLS is still on. A restore that dropped policies would look healthy
#    and be a data breach.
psql -c "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity"
```

The third query must return no rows. The server's own `schema-guard` test
asserts the same property, so a restored database can be checked by pointing
`TEST_DATABASE_URL` at it and running `pnpm --filter @ambitime/server test`.

### What is _not_ backed up

The pg-boss queue tables are in the same database and will be restored with it.
Jobs in flight at the moment of the backup will be redelivered — which is safe,
because the work is idempotent by construction (see `refreshCalendar`). The one
exception is notification delivery: a restore to a point before an email was
sent will send it again, since `delivered_at` is what prevents that and it will
have gone back too.

## Changing the Postgres image

**Do not swap the base image under an existing volume without reindexing.**
`postgres:18-alpine` collates text with musl and `postgres:18` with glibc, and
they disagree about ordering. Every text index built under the old one is then
silently wrong: unique constraints stop catching duplicates, and lookups miss
rows that are really there.

There is usually no warning. Postgres compares `pg_database.datcollversion`
against the library and complains when they differ — but a database created by
the alpine build records no version at all, so there is nothing to compare and
the mismatch passes unnoticed.

This is not hypothetical. It happened to this project's development volume: the
switch left `pgboss.queue` with four rows sharing one primary key, so
`boss.send` could not resolve a queue and returned null. The application code
was never involved.

To check:

```sql
select datname, datcollversion, pg_database_collation_actual_version(oid)
from pg_database where datname = current_database();
```

An empty or differing `datcollversion` means the indexes are suspect. To repair:

```sql
-- Unique indexes will refuse to build while the duplicates they let in remain,
-- so clear those first; what needs deleting depends on what got through.
REINDEX DATABASE ambitime;
ALTER DATABASE ambitime REFRESH COLLATION VERSION;
```

For a development volume, recreating it is faster and surer:
`docker compose down -v && docker compose up -d`.

## Tests never touch the running database

`pnpm test` truncates `users` between cases, and `users` cascades to every
tenant, planner, category and task below it. It therefore runs against
`ambitime_test`, which it creates on demand, and **never** falls back to
`DATABASE_URL` — that variable names the database the application is running
on, and the fallback deleted real data twice before it was removed. Setting
`TEST_DATABASE_URL` to the same value as `DATABASE_URL` is refused outright.

## Retention

`AUDIT_RETENTION_DAYS` bounds the command log (§12). It is unset by default,
and that default is deliberate: **undo reads the same log**, so a retention
window is also a limit on how far back a mistake can be taken. An installation
that sets one is trading reversibility for storage and should know it.

Pruning is `pruneAudit`, run on the system path — the log has UPDATE and DELETE
revoked from the application role, so nothing reachable from a request can touch
it.

## Security baselines (§14)

| Baseline                  | Where it lives             | Notes                                                                                                            |
| ------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Parameterised queries     | Drizzle throughout         | The one hand-written CTE (`task-tree.ts`) uses bound parameters; a test forbids raw writes in the command layer. |
| CORS                      | `createApp`, `corsOrigins` | Empty by default. Same-origin in the shipped deployment, because nginx proxies `/api`.                           |
| Rate limiting             | `api/rate-limit.ts`        | Per route class, per client. In-memory — see below.                                                              |
| XSS                       | Vue's escaping             | No `v-html` anywhere in the client; the check is a grep and it is worth keeping.                                 |
| No sensitive data in URLs | Route design               | Ids only. Sessions are HttpOnly cookies. Reset and confirmation tokens are the one exception — see below.        |
| Tenant isolation          | RLS, §5.2                  | Enforced by the database, not the application. `schema-guard.test.ts` fails if any table loses its policy.       |

### The rate limiter's honest limits

It counts **in memory, per process**. Behind two replicas the effective limit is
twice what is configured. It is a fixed window rather than a sliding one, so a
caller can spend a full budget at the end of one window and again at the start
of the next.

It is not a defence against a determined attacker — that belongs at the proxy —
but against a loop in a client, a stuck retry, and credential stuffing slow
enough to look like traffic. Moving the counter to Redis is a change of one
function when there is a second replica to justify it.

**It was also mounted at a path nothing could request, and did nothing at all
between M16c and the work that added password reset.** `basePath('/api')`
prefixes `use()` as well as `get()`, so `app.use('/api/auth/*')` registered
`/api/api/auth/*`. Every limiter existed, typechecked and matched no route.
`test/api/rate-limit.test.ts` now drives real paths through the app until a
limit is actually reached, which is the only assertion that could have caught
it — counting in isolation was never the part that was wrong.

There is a second limiter behind the first: Better Auth guards `/api/auth/*`
with its own rules, on by default when `NODE_ENV=production`. It answers 429
with `X-Retry-After` rather than `Retry-After`, and the client reads both.

## Email (§10.1, §11)

One transport carries everything outbound: §11's offline notifications, the
password-reset link and the address-confirmation link. It is a port with a
**logging default** — `loggingEmailSender()` writes the whole message to stdout
and sends nothing. Wiring a provider is one line in `src/index.ts`.

Until that line is changed, in plain terms:

- **Nobody can recover a forgotten password**, because the link is only in the
  log.
- **The reset and confirmation links are in your logs**, and each is a bearer
  token for the account. Following a confirmation link also signs the reader in.
  Treat the logs of a deployment with no mail provider as credential material.

### Requiring confirmation

`REQUIRE_EMAIL_VERIFICATION=true` stops an unconfirmed address signing in. It is
**off by default, and the default is about the transport**: with the logging
sender, requiring confirmation is an install nobody can sign in to.

Turn it on only once mail is really being delivered. Doing so also closes
something the sign-up form cannot close on its own — Better Auth stops
distinguishing "that address is taken" from "your account was created", because
with nothing revealed at the form the answer arrives in the mailbox or not at
all.

### Tokens in URLs

The §14 baseline says no sensitive data in URLs, and these two links are the
exception, because a link in an email is the only way to prove somebody reads
an address. What limits the exposure:

- Both are single-purpose and short-lived — one hour for a reset, one day for a
  confirmation (`src/auth/emails.ts`).
- The reset token is **consumed on use**; a second click fails.
- Resetting a password **revokes every session** the account had.
- The landing path travels in the request, because only the client knows its own
  routes, and Better Auth validates it against the trusted origins. A
  `redirectTo` pointing off-origin is refused with `403 INVALID_REDIRECT_URL`.
  Note that this check is disabled when `NODE_ENV=test`, so it is verified
  against a running stack rather than in the suite.

### Secrets

`BETTER_AUTH_SECRET` and `DATABASE_URL` come from the environment and are
validated at boot by `env.ts`, which refuses to start rather than running with a
missing one. Neither is logged: the API's error mapper returns a fixed message
for anything unrecognised, precisely so a stack trace or a connection string
cannot leave through a response.

## Security notes for a deployment

Three things the application cannot enforce about its own environment, and one
it now refuses to start without.

### The server must sit behind the proxy

The rate limiter identifies a caller from `X-Real-IP`, falling back to the
rightmost `X-Forwarded-For` hop — both written by nginx, which overwrites or
appends to whatever arrived. **Publishing the server's port directly hands
every caller free choice of both**, and with it an unlimited number of rate-
limit buckets on `/api/auth/*`. In `docker-compose.prod.yml` only nginx
publishes a port; keep it that way, and if the server is ever exposed for
debugging, close it again before the deployment is reachable.

The limiter is also **per process and in memory**. Behind two replicas the
effective limit is twice what is configured, which is a reason to put the real
limit at the proxy rather than a reason to distrust this one.

### `BETTER_AUTH_URL` must be the public HTTPS origin

Better Auth derives the session cookie's `Secure` attribute from this scheme.
Set to an `http://` origin, it issues sessions a browser will send in the clear.
The server now **refuses to start** when `NODE_ENV=production` and this is not
`https://`, so the misconfiguration is a failed boot rather than a quiet
weakening. A deployment terminating TLS at a load balancer should still set the
public origin here — that is what the cookie and the emailed links have to
match, not the address of the internal hop.

### The Content-Security-Policy assumes a same-origin deployment

`docker/nginx/prod/default.conf` sends `default-src 'self'` with `script-src`
strict. Serving the bundle from a CDN, adding analytics, or loading fonts from
elsewhere means widening it — and widening `script-src` in particular gives up
most of what it is for. `style-src` already allows inline because Vue writes
`style` attributes for anything it positions.

The header set is repeated inside `location /assets/`. That is not redundancy:
nginx's `add_header` **replaces** the inherited set rather than adding to it, so
any location that sets one header of its own loses all the others. A new
location block needs the full set copied into it.

### An accepted advisory

`pnpm audit` reports a moderate advisory against `esbuild` reached through
`drizzle-kit`. `drizzle-kit` is a **devDependency** used to generate migrations,
the vulnerability is in esbuild's development server, and neither is present in
the production image — which installs production dependencies only. It is worth
re-checking whenever the dependency moves, not worth pinning around today.
