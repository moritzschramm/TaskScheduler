# syntax=docker/dockerfile:1

FROM golang:1.23
WORKDIR /usr/src/app
STOPSIGNAL SIGKILL

COPY ../../server .

RUN go install github.com/mitranim/gow@latest
RUN go mod download
CMD gow -v run .
