# TaskScheduler
Mischung aus Todo- und Kalender-App. Nimmt sich Todos und versucht diese automatisch in einen Kalendertermin zu umzuwandeln, ohne, dass dabei Konflikte entstehen.

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
- [Go](https://go.dev/dl/)
- [Nodejs via NVM](https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating), install then run `nvm use latest` and test node installation with `node -v && npm -v`
- IDE of your choice, [VS Code](https://code.visualstudio.com/) recommended (nice extensions)

### Project setup
```sh
cd client
npm i # downloads vuejs dependencies
```

### Run API server locally
```sh
cd server
go run main.go
```
Server runs at http://127.0.0.1:3000

### Run client locally
```sh
cd client
npm run dev
```

### Start docker containers
#TODO