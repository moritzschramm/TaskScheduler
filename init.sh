#!/bin/bash

random_string=$(cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | fold -w 50 | head -c 32)

echo
echo -e "\033[1012mCreating necessary directories and configuration files...\033[0m"
echo

mkdir ./database/data
sed "s/<YOUR PASSWORD HERE>/$random_string/" .example.env > .env

echo
echo -e "\033[102mBuilding docker images...\033[0m"
echo

docker-compose build
docker-compose up -d

echo
echo -e "\033[102mMigrating database...\033[0m"
echo

sleep 20
cd ./database
./migrate.sh
cd ..

docker-compose down

echo
echo
echo -e "\033[92mDONE\033[0m"
echo -e "\033[102mYou can now start your dockerized dev env with 'docker-compose up'\033[0m"
