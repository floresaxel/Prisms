# Prisms web image: build the Vite/PWA bundle, then serve it (and reverse-proxy
# /api, /sync → api and /powersync → powersync) with nginx. Built from the repo
# root context so the pnpm workspace resolves.
# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.5.3
COPY . .
RUN pnpm install --frozen-lockfile --filter "@prisms/web..."
# PowerSync's public URL is baked into the bundle at build time (the browser
# connects to it directly for the sync stream).
ARG VITE_POWERSYNC_URL=/powersync
ENV VITE_POWERSYNC_URL=${VITE_POWERSYNC_URL}
RUN pnpm --filter @prisms/web build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
