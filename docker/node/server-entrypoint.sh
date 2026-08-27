#!/bin/sh
# Wait for Postgres, apply migrations, then hand off to the container command.
# Fine for the single-replica setup here; a multi-replica deploy should run
# migrations as a separate release step instead.
set -e

if [ -z "${DATABASE_URL}" ]; then
  echo "DATABASE_URL is not set" >&2
  exit 1
fi

echo "waiting for postgres..."
attempt=0
until pg_isready -d "${DATABASE_URL}" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 60 ]; then
    echo "postgres did not become ready in time" >&2
    exit 1
  fi
  sleep 1
done
echo "postgres is ready"

echo "applying migrations..."
if [ -f packages/server/dist/migrate.js ]; then
  node packages/server/dist/migrate.js
else
  pnpm --filter @ambitime/server db:migrate
fi

exec "$@"
