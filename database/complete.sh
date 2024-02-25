#!/bin/bash

# load env file from parent directory
[ ! -f ../.env ] || export $(grep -v '^#' ../.env | xargs)

db_dsn="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@$POSTGRES_HOST:5432/$POSTGRES_DB?sslmode=disable"
echo "Connecting to '$POSTGRES_USER@$POSTGRES_HOST:5432/$POSTGRES_DB'"

docker exec -it ts.pgroll sh -c "pgroll --postgres-url $db_dsn complete"
