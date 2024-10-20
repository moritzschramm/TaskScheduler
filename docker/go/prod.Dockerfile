# syntax=docker/dockerfile:1
FROM golang:1.23 as build-stage
WORKDIR /src
COPY ../../docker/prod/.env .
COPY ../../server .
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /server.x

FROM scratch as release-stage
COPY --from=build-stage /server.x /server.x
EXPOSE 3000
ENTRYPOINT [ "/server" ]
