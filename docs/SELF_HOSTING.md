# Self-hosting Prisms

Prisms is fully self-hostable with no vendor lock-in (R5): vanilla PostgreSQL is
the source of truth, PowerSync is the sync service, the API is a small Hono
server, and the web app is a static bundle. One `docker compose` command brings
up the whole stack.

## Stack (`docker-compose.prod.yml`)

| Service | Image / build | Role |
|---|---|---|
| `postgres` | `postgres:16` | Source of truth (logical replication on) |
| `powersync` | `journeyapps/powersync-service` | Sync Streams (edition-3, `packages/db/sync-streams.yaml`): `bootstrap`/`active` tiers auto-sync live rows, `history` (Tier 2, soft-deleted tombstones) + `journal_month` (day-notes, by month) lazily; every stream JWT-scoped by `user_id` — a subscription parameter (journal's `month`) may only NARROW within the user's own rows, never widen |
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

> **Terminate TLS in front.** The `web` container serves plain HTTP; put a reverse
> proxy (nginx/Caddy/Traefik) or a Tailscale HTTPS front in front of it. The bundled
> `infra/nginx/web.conf` already sets `X-Content-Type-Options`, `Referrer-Policy`,
> and a SPA/PowerSync-compatible CSP; its `Strict-Transport-Security` header is
> commented out — enable it once TLS is terminated. Auth cookies are `Secure`, so
> sign-in only works over HTTPS (or `localhost`).

## Secrets (`.env`)

Generate strong values (`openssl rand -base64 48`) for:

- `POSTGRES_PASSWORD` — database password. **Use a URL-safe value**
  (`openssl rand -hex 32`): it goes into the `postgresql://…` connection URIs,
  and a base64 value can contain `/`, which breaks URI parsing and stops the
  `api` and `powersync` services from connecting.
- `BETTER_AUTH_SECRET` — session/JWT signing for auth.
- `PS_JWT_SECRET` — the API signs short-lived HS256 PowerSync tokens with this
  (§13).
- `PS_JWT_K_B64URL` — the **same** secret, base64url-encoded, for the PowerSync
  `jwks` key. They must match:
  ```sh
  printf %s "$PS_JWT_SECRET" | basenc --base64url | tr -d '='
  ```
- `PUBLIC_URL` — the public origin (feeds Better Auth + CSRF trusted origins).

`PS_JWT_KID` / `PS_JWT_AUDIENCE` default to `prisms` and must be identical on the
API and in `infra/powersync/powersync.prod.yaml` — the compose file wires all
four `PS_JWT_*` values to both services (the sync service reads them directly;
the API reads them as its internal `POWERSYNC_JWT_*` vars).

> Local SQLite persistence on the desktop runs through the web SDK
> (wa-sqlite/OPFS) inside the Tauri WebView — PowerSync needs its own SQLite
> build (the `powersync` extension), which the Tauri SQL plugin can't host. See
> `apps/desktop/README.md`.

## Backup & restore

**Operator backup (whole database).** Postgres is the only durable state
(PowerSync storage and client SQLite are derived and rebuild from it):

```sh
./scripts/backup.sh ./backups            # pg_dump -Fc → ./backups/prisms-*.dump
./scripts/restore.sh ./backups/prisms-*.dump
docker compose -f docker-compose.prod.yml restart powersync   # re-replicate
```

**Per-user portable export/import (§13.1, in-app).** Each user can export their
own data from **Settings → Backup & restore** to a versioned `prisms-export`
file (facts, settings, command history, review items, provenance — never auth or
provider secrets), optionally passphrase-encrypted (AES-256-GCM with 600k-iteration
PBKDF2-SHA256; the default on desktop/mobile). Import **restores rows as data** — it never replays historical
commands — through the server `POST /sync/import` transaction (`?dry_run=1`
previews conflicts first) and advances the device HLC past the imported
high-water so later edits always order after the imported state (monotonicity).
No vendor lock-in: an export from one self-hosted instance restores into another.

## Upgrades

```sh
git pull
docker compose -f docker-compose.prod.yml up -d --build   # migrations run on api start
```

Migrations are forward-only and sync rules are versioned alongside the schema
(§16); mutation payloads only ever gain optional fields, so older clients keep
working during a rolling upgrade.

**Update clients before/with the server (D7).** The server rejects command
envelopes below its row-schema floor (`client_too_old`, with a Review-inbox
pointer). Envelope-version enforcement lands client-first: ship the updated
installed clients (they mint the version fields) before or with the server that
enforces the floor, so a rolling upgrade never locks out a not-yet-updated client.

**Scoped replication publication (R10/S6-F4).** The PowerSync publication covers
only the synced tables. The initdb script
(`infra/postgres/init/02-powersync-publication.sql`) creates the publication
*empty* — on a fresh database the app tables don't exist yet, so a table list
there would abort postgres' first boot — and migration
`packages/db/migrations/0009_powersync_publication.sql` scopes it to the synced
set once the tables exist. The same migration converts databases created under
the old `FOR ALL TABLES` publication (it drops and recreates the publication —
postgres rejects `SET TABLE` on `FOR ALL TABLES` publications), so upgrading is
just running migrations as usual. After upgrading a live deployment, restart
PowerSync so it reprocesses against the narrowed publication:

```sh
docker compose -f docker-compose.prod.yml restart powersync
```

**Journal day-notes (migration 0010).** The journal feature adds a `journal_entries`
table synced through a new lazy, month-bucketed `journal_month` stream. Its migration
(`packages/db/migrations/0010_journal.sql`) runs after 0009 and **also changes the
publication** — `ALTER PUBLICATION powersync ADD TABLE journal_entries` — because the
publication is scoped. So the same rule applies: after this upgrade lands on a live
deployment, **restart PowerSync** (the same `restart powersync` above) so it reprocesses
the new table. Omitting the restart leaves journals silently un-synced.

**Task checklist steps (migration 0011).** The substeps feature adds a `task_steps`
table (a per-task checklist) synced always-on through the `active` tier, its tombstones
in the lazy `history` tier. Its migration (`packages/db/migrations/0011_task_steps.sql`)
runs after 0010 and **also changes the publication** — `ALTER PUBLICATION powersync ADD
TABLE task_steps`. Same rule: after this upgrade lands on a live deployment, **restart
PowerSync** (the `restart powersync` above) so it reprocesses the new table. Omitting the
restart leaves checklist steps silently un-synced.

**History window (D4).** Soft-deleted rows and the `command_log` dedup history are
purged after **90 days** by the retention job — this is the v1 dedup/undo horizon,
not a user-facing archival guarantee. Longer retention is a post-v1 feature (the
history-compaction annex, A5).

## Verification status (this build environment)

The repo gate `pnpm turbo lint typecheck test` (21 tasks) is green, core
coverage is ≥ 90% (§16 floor), and the 100k-node load test meets the §15 budgets.
The incremental `StatusIndex` is **wired on both ends**: the client read layer
seeds it once per session and applies row-diffs (its per-command `apply` recomputes
only the affected node + neighbours, ~1 node / 0.02 ms on 100k), and the server
write path caches the per-batch context across a command batch rather than
rebuilding it per command. The two-device convergence harness
(`pnpm test:convergence`, 15 scenarios) and the server integration suites (incl.
the import/export round-trip and the two-user token-isolation check) pass against
local Postgres.

> **Not yet measured:** the 100k **cold-start sync-down** volume/time (bytes + wall
> clock a fresh device pulls from PowerSync). It needs a seeded-100k account against
> a booted stack; the topology now keeps soft-deleted tombstones out of the
> auto-subscribed tiers (Tier 2), but the number should be recorded on staging.

Not exercised in this environment (no toolchain/hardware): the clean-VM
one-command deploy was config-validated (`docker compose config`) but not run
end-to-end; the web Playwright suite (v1.0 behavioural flows + the v1.4 `m9`/
`m10`/`m13`/`v14` flows) needs the live browser stack; the mobile Maestro flow
needs an emulator; the desktop tauri-driver flow needs the Rust toolchain. CI
(`.github/workflows/ci.yml`) runs the unit + coverage + stack (DB/server/
convergence) + web-e2e jobs; mobile/desktop device e2e are wired for dedicated
runners.
