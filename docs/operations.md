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
| No sensitive data in URLs | Route design               | Ids only. Sessions are HttpOnly cookies; no token is ever a query parameter.                                     |
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

### Secrets

`BETTER_AUTH_SECRET` and `DATABASE_URL` come from the environment and are
validated at boot by `env.ts`, which refuses to start rather than running with a
missing one. Neither is logged: the API's error mapper returns a fixed message
for anything unrecognised, precisely so a stack trace or a connection string
cannot leave through a response.
