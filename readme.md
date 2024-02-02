# TaskScheduler (name not final)
A mix between a todo and calendar app. Takes todos and tries to convert them
into a task (calendar entry), without creating conflicts with existing entries. The timespan when a task can be scheduled is adaptable.

## Setup
Make sure that [Docker](https://www.docker.com/products/docker-desktop/) is installed.

Create a data directory, copy and edit the .env file to provide all services with the neccessary configuration variables:
```sh
mkdir database/data
cp .example.env .env
```
**Set a database user password in the .env file that was just copied.**

Make sure docker is running, then start docker compose:
```sh
docker-compose up
```
After the first launch, migrate to the current database schema:
```sh
cd database
./migrate.sh
```

The client and API are available at http://localhost:8000(/api). Also, Postgres is exposed on port 5432 and Redis on port 6379.

If there are any file changes (in client or server), the node and go docker services will automatically recompile the project and the changes will be live (even with HMR in client!).

## Planned Features
- Crude calendar and todo list view
- Multiple todo lists / dynamical, daily lists
- Adaptable "working hours"
- Moving many todos from one day to the next (conflict free)
- Statistics for how many times a task was moved
