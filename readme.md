# TaskScheduler
Mischung aus Todo- und Kalender-App. Nimmt sich Todos und versucht diese automatisch in einen Kalendertermin umzuwandeln, ohne, dass dabei Konflikte entstehen.

## Funktionen
- Mehrere Todo Listen (z.B. Arbeit, Privat, sonstiges...) / dynamische, tägliche Todo Listen
- Eintragung von Arbeitszeitblöcken um Tasks planen zu können
- Funktion mehrere Tasks (z.B. alle an einem Tag) ohne größeren Aufwand umzuplanen und ohne Konflikte entstehen zu lassen (-> nützlich für Krank / Urlaub)
- Verschiebung von Todos tracken und Nutzer nach zu vielen "Umplanungen" darauf aufmerksam machen

## Technologie
- Frontend: Typescript, Vue3 mit Tailwind CSS (als SPA)
- API server: Go, mit Fiber als Framework um API bereitzustellen
- Database: Postgres (evtl noch redis für session)
- Nginx als reverse proxy um statische Dateien bereitzustellen und als SSL endpoint für API
- alles in Docker containern für leichtes dev setup und schnelles deployment

## Dev Setup
### Requirements
- [Docker](https://www.docker.com/products/docker-desktop/)

optionally (though everything is run in docker containers):
- [Go](https://go.dev/dl/)
- [Nodejs via NVM](https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating), install then run `nvm use latest` and test node installation with `node -v && npm -v`
- IDE of your choice, [VS Code](https://code.visualstudio.com/) recommended (nice extensions)

### Setup
Make sure Docker Desktop is running, then start docker compose:
```sh
docker-compose up
```
This will expose the frontend to http://localhost:5173 and the API to http://localhost:3000/v/0/. Also, a Postgres service is started in the background and exposed on port 5432. 

If there are any file changes (in client or server), the node and go service will automatically recompile the project and the changes will be live (even with HMR in client!).