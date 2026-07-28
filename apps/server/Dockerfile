# Prisms API image (Hono + Better Auth + pg-boss jobs). Built from the repo
# root context so the pnpm workspace (core, db, server) resolves.
#
# Layering (audit S10-F6): the dependency layer is keyed on the lockfile alone
# (`pnpm fetch` into the store), so source-only changes rebuild in seconds
# without re-downloading packages; the runtime stage ships only the server's
# workspace subtree (core + db + server) and its node_modules — no pnpm store,
# no unrelated workspace packages.
# syntax=docker/dockerfile:1

# --- deps: lockfile-first package fetch (cache-friendly) ---------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@11.5.3
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# --- build: manifests + sources, offline filtered install --------------------
FROM deps AS build
COPY package.json ./
# Every workspace manifest must be present for --frozen-lockfile to validate
# (the lockfile spans all seven projects); only the server subtree gets sources.
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY apps/desktop/package.json apps/desktop/
COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/server apps/server
RUN pnpm install --frozen-lockfile --offline --filter "@prisms/server..."

# --- runtime: the server subtree only (no pnpm store, no fetch cache) --------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN npm install -g pnpm@11.5.3
COPY --from=build /app /app

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# SEC-1/F14: drop root. The API needs no privileged port (3001) and writes
# nothing outside the container, so a container escape or an RCE in a dependency
# should not land as uid 0. `node` (uid 1000) ships with the base image; it owns
# /app so pnpm can still resolve the workspace at start.
RUN chown -R node:node /app
USER node

# Apply forward-only migrations, then serve the API + start pg-boss jobs.
CMD ["sh", "-c", "pnpm --filter @prisms/db db:migrate && pnpm --filter @prisms/server start"]
