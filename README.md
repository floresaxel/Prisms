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
| `apps/web` | `@prisms/web` | Vite + React SPA |
| `apps/mobile` | `@prisms/mobile` | Expo (React Native) |
| `apps/desktop` | `@prisms/desktop` | Tauri v2 shell |
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

Host ports are overridable in a local `.env` (gitignored) when the defaults
are taken — e.g. `PRISMS_POSTGRES_PORT=5434`, `PRISMS_POWERSYNC_PORT=8081`.
Note WSL shuts down when idle; re-running any `wsl docker ...` command boots
it again and the containers auto-start (`restart: unless-stopped`).

Architectural rules (package boundaries, core purity bans) are enforced by ESLint — see `eslint.config.mjs` — and regression-tested in `packages/core/test/architecture-lint.test.ts`.

## Session status

- [x] S1 — Monorepo scaffold
- [x] S2 — Domain types, schemas, time (HLC, bucketDate, Clock/Rng, UUID helpers)
- [x] S3 — Database package (Drizzle schema, migrations, sync rules, demo seed)
- [x] S4 — Graph module (tree/DAG ops, sort order, I1–I4/I10 validators, critical path)
- [x] S5 — Status + predicate AST (§7.1 status fn, phase derivation, tri-state §9.2 evaluator)
- [x] S10 — API shell + auth (Hono, Better Auth, PowerSync JWT, settings.update, rate limiter)
- [ ] S5+ — see [Blueprints/BUILD_PLAN.md](Blueprints/BUILD_PLAN.md)
