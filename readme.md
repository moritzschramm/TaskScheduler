# TaskScheduler (name not final)
A mix between a todo and calendar app. Creates tasks from todos by inserting them into the calendar while avoiding conflicts with existing entries. A task is scheduled in a predefined timespan.

## Setup
Make sure that [Docker](https://www.docker.com/products/docker-desktop/) is installed.

### Setting the config vars
```sh
mkdir database/data
cp .example.env .env
```
Create a data directory, then copy and edit the .env file to provide all services with the neccessary configuration variables:
> **Set a database user password in the .env file that was just copied.**

### Launching the application
```sh
docker-compose up -d
```

### Migrate database after first launch
```sh
cd database
./migrate.sh
```

The client and API are available at http://localhost:8000. Also, Postgres and Redis are exposed on port 5432 and 6379 respectively.

If there are any file changes (in client or server), the dockerized node and go services will automatically recompile the project and the changes will be live (even with HMR in client!).

## Planned Features
[ ] Crude calendar and todo list view
[ ] Multiple todo lists / dynamical, daily lists
[ ] Adaptable "working hours"
[ ] Moving many todos from one day to the next (conflict free)
[ ] Statistics for how many times a task was moved
