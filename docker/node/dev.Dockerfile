# syntax=docker/dockerfile:1

FROM node:21
WORKDIR /usr/src/app
STOPSIGNAL SIGKILL
EXPOSE 5173

COPY ../../client .

RUN npm install
CMD npm run docker-dev
