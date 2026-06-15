# Prisms

Local-first goal-execution platform: `Vision → Roadmap → Project → Milestone → Task → Schedule`, with skills & habits as a parallel track.

- **Spec:** [Blueprints/ARCHITECTURE.md](Blueprints/ARCHITECTURE.md) (normative)
- **Build plan:** [Blueprints/BUILD_PLAN.md](Blueprints/BUILD_PLAN.md) (20 dependency-ordered sessions)

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
Note WSL shuts down when idle; re-running any `wsl docker ...` command boots
it again and the containers auto-start (`restart: unless-stopped`).

Architectural rules (package boundaries, core purity bans) are enforced by ESLint — see `eslint.config.mjs` — and regression-tested in `packages/core/test/architecture-lint.test.ts`.

## Production / self-hosting

One command on a clean host brings up Postgres + PowerSync + the API + the web
bundle (`docker-compose.prod.yml`). See **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**
for secrets, the JWT key derivation, backup/restore, and upgrades.

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

All 23 build sessions complete. The repo gate is `pnpm turbo lint typecheck test`
(21 tasks) plus the web Playwright suite (`pnpm --filter @prisms/web e2e`) and the
core coverage gate (`pnpm --filter @prisms/core test:coverage`).
