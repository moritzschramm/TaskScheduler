# TaskScheduler

A mix between a todo and calendar app. Creates tasks from todos by inserting them into the calendar while avoiding conflicts with existing entries. A task is scheduled in a predefined timespan.

## Project Structure

Important files and directories:

- `init.sh` initializes and resets application
- `docker-compose.yml` file and `docker` directory: Orchestration of containers and image specification
- `.example.env` and `.env` contain relevant configuration variables
- `client` contains code for the frontend client application
- `server` contains code for the backend API
- `database`: `/internal` is used by some docker services, `/migrations` contains all database changes

## Setup

Make sure that [Docker](https://www.docker.com/products/docker-desktop/) is installed and running. Then, execute the init script:

```sh
./init.sh
```

## Launching the application (dev env)

```sh
docker-compose up
```

The client and API should be available at http://localhost:8000.

Also, Postgres and Redis dashboards are available at http://localhost:5050 and http://localhost:5051 respectively.

### Development

If there are any file changes (in client or server), the dockerized node and go services will automatically recompile the project and the changes will be live (even with HMR in client!).

## Planned Features

- [ ] Crude calendar and todo list view
- [ ] Multiple todo lists / dynamical, daily lists with priorities
- [ ] Adaptable "working hours"
- [ ] Moving many todos from one day to the next (conflict free)
- [ ] Statistics for how many times a task was moved
