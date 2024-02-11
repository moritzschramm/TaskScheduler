# TaskScheduler (name not final)
A mix between a todo and calendar app. Creates tasks from todos by inserting them into the calendar while avoiding conflicts with existing entries. A task is scheduled in a predefined timespan.

## Setup
Make sure that [Docker](https://www.docker.com/products/docker-desktop/) is installed.

#### Setting the config vars
```sh
mkdir database/data     # create necessary data directory for postgres
docker-compose build    # build docker containers of go and node service
cp .example.env .env
```
> [!IMPORTANT]
> **Set a password for the database user in the .env file that was just copied.**

#### Launching the application
```sh
docker-compose up
```

#### Migrate database schema after first launch
```sh
./database/migrate.sh
```

After completing the setup, the client and API should be available at http://localhost:8000. Also, Postgres and Redis are exposed on port 5432 and 6379 respectively.

## Development
If there are any file changes (in client or server), the dockerized node and go services will automatically recompile the project and the changes will be live (even with HMR in client!).

## Planned Features
 - [ ] Crude calendar and todo list view
 - [ ] Multiple todo lists / dynamical, daily lists
 - [ ] Adaptable "working hours"
 - [ ] Moving many todos from one day to the next (conflict free)
 - [ ] Statistics for how many times a task was moved
