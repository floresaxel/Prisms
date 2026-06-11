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

Architectural rules (package boundaries, core purity bans) are enforced by ESLint — see `eslint.config.mjs` — and regression-tested in `packages/core/test/architecture-lint.test.ts`.

## Session status

- [x] S1 — Monorepo scaffold
- [ ] S2+ — see [Blueprints/BUILD_PLAN.md](Blueprints/BUILD_PLAN.md)
