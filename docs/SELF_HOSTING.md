# Self-hosting Prisms

Prisms is fully self-hostable with no vendor lock-in (R5): vanilla PostgreSQL is
the source of truth, PowerSync is the sync service, the API is a small Hono
server, and the web app is a static bundle. One `docker compose` command brings
up the whole stack.

## Stack (`docker-compose.prod.yml`)

| Service | Image / build | Role |
|---|---|---|
| `postgres` | `postgres:16` | Source of truth (logical replication on) |
| `powersync` | `journeyapps/powersync-service` | Sync stream + buckets per `user_id` |
| `api` | `apps/server/Dockerfile` | Hono + Better Auth + command dispatcher + pg-boss jobs; runs migrations on start |
| `web` | `apps/web/Dockerfile` → nginx | Static SPA; reverse-proxies `/api`, `/sync` → api and `/powersync` → powersync (single-origin) |

The desktop app (Tauri) and mobile app (Expo) are **clients** of this same
stack — they are not part of the server deployment.

## Deploy (clean host)

Prerequisites: Docker + Docker Compose v2.

```sh
cp .env.example .env
# edit .env — see "Secrets" below
docker compose -f docker-compose.prod.yml up -d --build
```

The web app is then served on `http://<host>:${WEB_PORT:-8088}`. The `api`
container applies forward-only migrations before serving, so a fresh database
is initialized automatically.

## Secrets (`.env`)

Generate strong values (`openssl rand -base64 48`) for:

- `POSTGRES_PASSWORD` — database password. **Use a URL-safe value**
  (`openssl rand -hex 32`): it goes into the `postgresql://…` connection URIs,
  and a base64 value can contain `/`, which breaks URI parsing and stops the
  `api` and `powersync` services from connecting.
- `BETTER_AUTH_SECRET` — session/JWT signing for auth.
- `POWERSYNC_JWT_SECRET` — the API signs short-lived HS256 PowerSync tokens with
  this (§13).
- `POWERSYNC_JWT_K_B64URL` — the **same** secret, base64url-encoded, for the
  PowerSync `jwks` key. They must match:
  ```sh
  printf %s "$POWERSYNC_JWT_SECRET" | basenc --base64url | tr -d '='
  ```
- `PUBLIC_URL` — the public origin (feeds Better Auth + CSRF trusted origins).

`POWERSYNC_JWT_KID` / `POWERSYNC_JWT_AUDIENCE` default to `prisms` and must be
identical on the API and in `infra/powersync/powersync.prod.yaml` (they are,
via the same env vars).

> Local SQLite persistence on the desktop runs through the web SDK
> (wa-sqlite/OPFS) inside the Tauri WebView — PowerSync needs its own SQLite
> build (the `powersync` extension), which the Tauri SQL plugin can't host. See
> `apps/desktop/README.md`.

## Backup & restore

Postgres is the only durable state (PowerSync storage and client SQLite are
derived and rebuild from it):

```sh
./scripts/backup.sh ./backups            # pg_dump -Fc → ./backups/prisms-*.dump
./scripts/restore.sh ./backups/prisms-*.dump
docker compose -f docker-compose.prod.yml restart powersync   # re-replicate
```

## Upgrades

```sh
git pull
docker compose -f docker-compose.prod.yml up -d --build   # migrations run on api start
```

Migrations are forward-only and sync rules are versioned alongside the schema
(§16); mutation payloads only ever gain optional fields, so older clients keep
working during a rolling upgrade.

## Verification status (this build environment)

The repo gate `pnpm turbo lint typecheck test` (21 tasks) is green, core
coverage is ≥ 90% (§16 floor), and the 100k-node load test meets the §15
budgets (single status recompute well under 16ms; FactContext build under
100ms). The web Playwright suite (12 flows) passes against the live stack.

Not exercised in this environment (no toolchain/hardware): the clean-VM
one-command deploy was config-validated (`docker compose config`) but not run
end-to-end; the mobile Maestro flow needs an emulator; the desktop tauri-driver
flow needs the Rust toolchain. CI (`.github/workflows/ci.yml`) runs the unit +
coverage + stack + web-e2e jobs; mobile/desktop device e2e are wired for
dedicated runners.
