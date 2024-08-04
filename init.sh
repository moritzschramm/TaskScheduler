#!/bin/bash

# cleanup to start from scratch
echo -e "\033[102mPerforming cleanup...\033[0m"

docker-compose down
rm -rf ./database/internal

echo -e "\033[102mCreating local directories and configuration files...\033[0m"

mkdir -p ./database/internal/postgres ./database/internal/redis ./database/internal/redisinsight ./database/internal/pgadmin # create necessary data directories
database_password=$(cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | fold -w 50 | head -c 32) # generate db password
touch .env
sed "s/<YOUR PASSWORD HERE>/$database_password/" .example.env > .env # generate env file
[ ! -f .env ] || export $(grep -v '^#' .env | xargs) # load variables from env file

echo -e "\033[102mBuilding docker images...\033[0m"

docker-compose build
docker-compose up -d

echo -e "\033[102mMigrating database...\033[0m"

sleep 15 # wait for postgres and pgAdmin init to complete
db_dsn="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@$POSTGRES_HOST:5432/$POSTGRES_DB?sslmode=disable"
docker exec -it ts.pgroll sh -c "pgroll init --postgres-url $db_dsn"
cd ./database
./migrate.sh 0001_create_users_table.json
./complete.sh
cd ..

docker-compose down

echo
echo
echo -e "\033[92mDONE\033[0m"
echo -e "You can now start your dockerized dev env using \033[102mdocker-compose up\033[0m"
