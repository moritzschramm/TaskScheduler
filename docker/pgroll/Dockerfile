# syntax=docker/dockerfile:1

FROM golang:1.22
WORKDIR /usr/src/pgroll
STOPSIGNAL SIGKILL

COPY ../../database/migrations .

RUN go install github.com/xataio/pgroll@latest
