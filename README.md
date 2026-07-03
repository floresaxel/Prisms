# Prisms

Local-first goal-execution platform: `Vision → Roadmap → Project → Milestone → Task → Schedule`, with skills & habits as a parallel track.

- **Spec:** [Blueprints/ARCHITECTURE.md](Blueprints/ARCHITECTURE.md) (v1.0 baseline) → [Blueprints/other/ARCHITECTURE_1.3.md](Blueprints/other/ARCHITECTURE_1.3.md) (v1.3/1.4 convergence + read-path layer — the current contract)
- **Build plans:** [Blueprints/BUILD_PLAN.md](Blueprints/BUILD_PLAN.md) (v1.0, S1–S23) → [Blueprints/other/MIGRATION_PLAN_v1.0_to_v1.4.md](Blueprints/other/MIGRATION_PLAN_v1.0_to_v1.4.md) (v1.4 migration, M0–M15)

## Workspace

| Path | Package | Purpose |
|---|---|---|
| `packages/core` | `@prisms/core` | Pure domain logic — no IO, no wall clock, no randomness (lint-enforced) |
| `packages/db` | `@prisms/db` | Drizzle schema, migrations, PowerSync sync rules |
| `packages/ui` | `@prisms/ui` | Shared reactive React hooks |
| `apps/web` | `@prisms/web` | Vite + React SPA (full feature surface incl. flowcharts/Gantt/editors) |
| `apps/mobile` | `@prisms/mobile` | Expo (React Native) — lists/agenda/kanban/timer/habits + read-only graphs |
| `apps/desktop` | `@prisms/desktop` | Tauri v2 shell loading the web build |
| `apps/server` | `@prisms/server` | Hono API + Better Auth + pg-boss jobs |

## Architecture (v1.4 — two-layer, convergent)

The v1.0 single-table optimistic model was migrated (M0–M15) to the v1.3/1.4
convergence + read-path contracts. The load-bearing pieces:

- **Two-layer client store (R15).** The UI reads `mergeTable(replica, overlay)`:
  a read-only canonical replica synced down from Postgres, plus a local-only
  optimistic overlay of pending commands (`client_commands` + `overlay_effects`).
  Rollback = drop the overlay entry; overlays never upload as row patches.
- **Named command envelopes are the only trusted write path.** The client mints
  the command id (UUIDv7) + HLC at write and uploads the envelope preserving them
  (V2); the server owns all trust fields (ownership/provenance/system/`hlc`/
  `schema_version`, R17). A compile-time-exhaustive coverage test proves every
  `CommandName` has an `executeCommand` writer — the old CRUD-patch path is gone.
- **Deterministic convergence.** Per-field LWW by HLC, with explicit merge
  functions for `(sort_order, hlc)` and `mergeTimeEntries` (union-not-sum). A
  13-scenario two-device harness (`pnpm test:convergence`) is the gate.
- **Sync Streams tiers (§7.3).** `bootstrap`/`active` auto-sync; `history` (Tier 2)
  is subscribed lazily. All streams are JWT-scoped with no client-widenable params.
- **Incremental `StatusIndex` (§7.12), wired.** The client read layer seeds the
  index once per session and feeds it row-diffs (R7), so an optimistic write updates
  the merged status view incrementally instead of rebuilding `FactContext`; the
  index's per-command `apply` is O(neighbourhood), not O(table) (measured: 1 node /
  ~0.02 ms, touch-set < 100, on a 100k-node account). The server write path caches
  the per-batch context (tree / edge index / `FactContext`) across a command batch
  and parallelises its context load (R8), so it is no longer an O(table) rebuild per
  command.
- **Persistent, loading-aware read layer (§7.14/7.15).** `PrismsDataProvider`
  above the router owns the shared subscriptions + `FactContext` once per session;
  reads are stale-while-revalidate with a remount-surviving cache, so navigation
  never cold-flashes and a fresh login shows a skeleton, not the empty state.
- **Conflict/rejection inbox (§7.13).** Server rejections, dependency rejections,
  HLC conflicts, automation drift, schema-version blocks, and import/sync warnings
  become durable `sync_review_items` that sync to every client's Review screen.
- **Portability (§13.1).** Versioned `prisms-export` backup/restore: import
  restores rows as data (never replays commands) and advances the device HLC past
  the imported high-water; optional passphrase encryption (default on installed
  targets). Secrets sit behind a secure-storage adapter; DB encryption behind an
  adapter port.

## Development

```sh
pnpm install
pnpm turbo lint typecheck test   # the repo gate (also run in CI)
docker compose up -d postgres    # local Postgres (wal_level=logical)
```

### Windows without Docker Desktop

Docker Engine runs fine inside WSL2 (Ubuntu, systemd). From the repo root in
PowerShell:

```powershell
wsl docker compose up -d   # boots postgres + powersync + api
wsl docker compose ps
```

Then bring the database and API up to date:

```sh
pnpm --filter @prisms/db db:migrate    # forward-only migrations
pnpm --filter @prisms/db db:seed       # demo user (optional)
pnpm --filter @prisms/server dev       # real API on :3001 (compose api stub is a placeholder)
pnpm --filter @prisms/web dev          # web app on :5173 (proxies /api + /sync to :3001)
```

The web app (`apps/web`) is a Vite + React SPA on PowerSync (wa-sqlite/OPFS).
In dev, Vite reverse-proxies `/api` + `/sync` to the API so the browser is
same-origin. The Playwright DoD e2e (`pnpm --filter @prisms/web e2e`) runs
against the production build served by `vite preview` (real service worker for
offline) with the stack up — start the API with
`BETTER_AUTH_URL=http://localhost:5173 BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173`.

Cookie-authenticated POSTs require a trusted `Origin` (CSRF, §13): the API's
own origin is always trusted; add cross-origin clients (e.g. the Vite dev
server) via `BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173`.

Host ports are overridable in a local `.env` (gitignored) when the defaults
are taken — e.g. `PRISMS_POSTGRES_PORT=5434`, `PRISMS_POWERSYNC_PORT=8081`.
The web client's default PowerSync URL is `http://localhost:8080` (matching
compose); if you remap the container port, point the client at it too, e.g.
`VITE_POWERSYNC_URL=http://localhost:8081` in `apps/web/.env.local`.
Note WSL shuts down when idle; re-running any `wsl docker ...` command boots
it again and the containers auto-start (`restart: unless-stopped`).

Architectural rules (package boundaries, core purity bans) are enforced by ESLint — see `eslint.config.mjs` — and regression-tested in `packages/core/test/architecture-lint.test.ts`.

## Production / self-hosting

One command on a clean host brings up Postgres + PowerSync + the API + the web
bundle (`docker-compose.prod.yml`). See **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**
for secrets, the JWT key derivation, backup/restore (operator + per-user portable
export), and upgrades, and **[docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)**
for the §13 security review (trusted write path, stream scoping, trust fields,
secure storage, encryption limits).

```sh
cp .env.example .env          # fill in secrets
docker compose -f docker-compose.prod.yml up -d --build
```

## Session status

- [x] S1 — Monorepo scaffold
- [x] S2 — Domain types, schemas, time (HLC, bucketDate, Clock/Rng, UUID helpers)
- [x] S3 — Database package (Drizzle schema, migrations, sync rules, demo seed)
- [x] S4 — Graph module (tree/DAG ops, sort order, I1–I4/I10 validators, critical path)
- [x] S5 — Status + predicate AST (§7.1 status fn, phase derivation, tri-state §9.2 evaluator)
- [x] S6 — Aggregates (practice hours/levels, six streak modes, progress, completion %, burndown + projection, time-left)
- [x] S7 — Rules engine (spawn automations, fixpoint MAX_DEPTH=5, UUIDv5 outputs, self-trigger guard)
- [x] S8 — Scheduler · greedy (earliest-fit, window hints, dependency+lag, single-task reschedule)
- [x] S9 — Scheduler · optimize (weighted soft objectives, local search over greedy seed, proposal diffing)
- [x] S10 — API shell + auth (Hono, Better Auth, PowerSync JWT, settings.update, rate limiter)
- [x] S11 — Command dispatcher + full §8.1 catalog (49 verbs, invariant checks, idempotency, backstop enqueue)
- [x] S12 — Convergence harness (two-device HLC LWW, §7.4 double clock-in, UUIDv5 automation convergence)
- [x] S13 — Jobs I · facts & truth (pg-boss: weather.poll, aggregates.recompute, automation.backstop, retention.purge)
- [x] S14 — Jobs II · scheduling & notify (schedule.optimize, pastdue.scan, layout.precompute/ELK, notify.dispatch)
- [x] S15 — Web shell + data layer (Vite+React, PowerSync/OPFS, ui hooks, optimistic apply + rollback, PWA; Playwright DoD ✓)
- [x] S16 — Worklist, timer, focus review, activity inbox (offline loop; double-timer impossible)
- [x] S17 — Agenda (week calendar + to-do, drag/tap-to-place with live window hints, anchored/suggested/grey, block move/resize)
- [x] S18 — Kanban by date + habits (streaks, daily-target rings, practice hours/levels)
- [x] S19 — Dashboard (burndown + projection + completion + priority + streaks) + decision board
- [x] S20 — Graph surfaces (React Flow flowcharts, Gantt) + automation/blocker editors + settings
- [x] S21 — Mobile core (Expo): reuses the platform-neutral `@prisms/ui`; lists/agenda/kanban/timer/habits + read-only graph + local notifications
- [x] S22 — Desktop (Tauri v2 shell around the web build; OS notifications)
- [x] S23 — Hardening & release (CI matrix, core coverage ≥90%, prod compose + backup/restore, self-hosting guide, 100k-node load budgets)

All 23 v1.0 build sessions complete. The **v1.4 migration** (M0–M15) is also
complete: two-layer client store, Sync Streams tiers, incremental `StatusIndex`,
6-step dispatcher with causal ordering + server-owned trust fields, automation
drift backstop, 13-scenario convergence gate, review inbox, persistent +
loading-aware read layer, portable encrypted import/export, and mobile/desktop
parity. See [Blueprints/other/MIGRATION_PLAN_v1.0_to_v1.4.md](Blueprints/other/MIGRATION_PLAN_v1.0_to_v1.4.md).

The repo gate is `pnpm turbo lint typecheck test` (21 tasks) plus the web
Playwright suite (`pnpm --filter @prisms/web e2e`, incl. the `v14` no-flash
read-path + `m13` import/export flows), the two-device convergence harness
(`pnpm test:convergence`), and the core coverage gate
(`pnpm --filter @prisms/core test:coverage`).
