#!/bin/bash

echo
echo -e "\033[1012mCreating necessary directories and configuration files...\033[0m"
echo

database_password=$(cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | fold -w 50 | head -c 32)
rm -rf ./database/data # remove already exisiting directory, if present
mkdir ./database/data
sed "s/<YOUR PASSWORD HERE>/$database_password/" .example.env > .env

echo
echo -e "\033[102mBuilding docker images...\033[0m"
echo

docker-compose build
docker-compose up -d

echo
echo -e "\033[102mMigrating database...\033[0m"
echo

sleep 20 # wait for postgres init to complete
cd ./database
./migrate.sh
cd ..

docker-compose down

echo
echo
echo -e "\033[92mDONE\033[0m"
echo
echo -e "\033[102mYou can now start your dockerized dev env using \033[0m docker-compose up"
