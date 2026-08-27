# ---------------------------------------------------------------------------
# Multi-stage production build. `--target server` / `--target client` selects
# which artifact to produce; both share one dependency-install layer.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/scheduler/package.json ./packages/scheduler/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

RUN pnpm install --frozen-lockfile


FROM deps AS build
COPY . .
RUN pnpm --filter @ambitime/server build && pnpm --filter @ambitime/client build


# --- server runtime -------------------------------------------------------
FROM node:24-alpine AS server

RUN corepack enable
RUN apk add --no-cache postgresql17-client
WORKDIR /app
ENV NODE_ENV=production

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/scheduler/package.json ./packages/scheduler/

# Workspace packages are bundled into dist by esbuild, so only third-party
# production dependencies are needed at runtime.
# Store pruned in the same layer: pnpm's content-addressable store is a full
# second copy of every package as far as Docker's layer accounting is concerned.
RUN pnpm install --frozen-lockfile --prod --filter @ambitime/server... \
    && pnpm store prune \
    && rm -rf /root/.local/share/pnpm/store /root/.cache/pnpm

COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/drizzle ./packages/server/drizzle
COPY docker/node/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh
RUN chmod +x /usr/local/bin/server-entrypoint.sh

USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/server-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]


# --- client static bundle, served by nginx --------------------------------
FROM nginx:1.29-alpine AS client

COPY --from=build /app/packages/client/dist /usr/share/nginx/html
COPY docker/nginx/prod/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
