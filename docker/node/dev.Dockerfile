# Shared dev image for the server and the client dev server.
# Source is bind-mounted by compose; only dependencies are baked in.
FROM node:24-alpine

RUN corepack enable

WORKDIR /app

# Postgres client tooling for the server's wait-for-db entrypoint.
RUN apk add --no-cache postgresql17-client

# Copy only what pnpm needs to resolve the workspace, so a source edit does not
# invalidate the dependency layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/scheduler/package.json ./packages/scheduler/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

RUN pnpm install --frozen-lockfile

COPY . .

# Outside /app so the source bind-mount does not shadow it.
COPY docker/node/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh
RUN chmod +x /usr/local/bin/server-entrypoint.sh

EXPOSE 3000 5173
