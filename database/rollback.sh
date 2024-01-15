#!/bin/bash

liquibase_image="liquibase/liquibase:4.25"
liquibase_image_hash=$(docker image ls $liquibase_image --quiet)

if [[ $liquibase_image_hash == "" ]]; then
    echo "Liquibase not installed, installing now..."
    docker pull $liquibase_image
fi

# load env file from parent directory
[ ! -f ../.env ] || export $(grep -v '^#' ../.env | xargs)

db_dsn="postgresql://db:5432/$POSTGRES_DB"
echo "Connecting to '$POSTGRES_USER@db:5432/$POSTGRES_DB'"

docker run --network=taskscheduler_skynet --rm -v ./migrations:/liquibase/changelog liquibase/liquibase --url="jdbc:$db_dsn" --changeLogFile="root.changelog.yml" --username=$POSTGRES_USER --password=$POSTGRES_PASSWORD rollback-count --count=$1 