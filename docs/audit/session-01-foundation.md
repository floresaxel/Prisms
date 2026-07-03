# Audit Session 1 — Foundation, Tooling, CI, Workspace Hygiene

Audited at commit `2ab3bf7` (branch `m0-spike`, clean), 2026-07-01.

**Scope examined:** root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, all 7 workspace manifests, `vitest.config.ts` per app, `.github/workflows/ci.yml`, repo layout vs spec §6, stack vs §5, verification commands vs §15, migrations inventory, core-purity spot checks.

**Verdict:** foundation is in very good shape — strict TS everywhere, spec-mapped lint enforcement (boundaries + core purity), a real 3-job CI matrix (unit+coverage, integration vs live Postgres/PowerSync, Playwright e2e vs a live stack), documented pnpm overrides, forward-only migrations. Findings below are footguns and hygiene, not broken features. One item (F6, React override vs Expo) is a genuine runtime risk that Session 9 must resolve.

---

## Findings

### S1-F1 · Medium — turbo cache is blind to `PRISMS_DB_TEST_URL` / `PRISMS_POWERSYNC_URL`

**Evidence:** `turbo.json` declares no `env`/`globalEnv` for any task. Server/db integration suites self-skip when `PRISMS_DB_TEST_URL` is unset (by design). Today's baseline run replayed 21/21 tasks from cache in 253 ms, with logs showing `dispatcher.integration.test.ts` etc. — 109 of 114 server tests — skipped.

**Failure mode:** the cache key ignores those env vars, so a developer who brings Postgres up and re-runs `pnpm turbo test` gets a cached green replay in which the integration tests never ran (and symmetrically, a cached "ran vs PG" result replays when PG is down). CI is unaffected only because the `stack` job calls `pnpm --filter @prisms/{db,server} test` directly, bypassing turbo.

**Suggested change:** in `turbo.json`, add to the `test` task: `"env": ["PRISMS_DB_TEST_URL", "PRISMS_POWERSYNC_URL"]`. One line; makes local gate results honest.

### S1-F2 · Low — `passWithNoTests: true` in packages that have (or should have) tests

**Evidence:** `apps/web/vitest.config.ts:6`, `apps/mobile/vitest.config.ts:6`, `apps/desktop/vitest.config.ts:6` all set `passWithNoTests: true` (server correctly sets `false`). Mobile and desktop currently have zero test files — their green "test" tasks are vacuous. Web *does* have real unit tests (e.g. `test/data-provider.test.ts`), so its `true` is a latent trap: an include-glob or tsconfig regression that discovers 0 files would keep the gate green while silently running nothing.

**Suggested change:** set `passWithNoTests: false` in `apps/web` (it has tests; there is no reason to tolerate zero). For mobile/desktop either add one real smoke test each (mobile: `secure-storage` port conformance; desktop: `isDesktop()`/config) and flip to `false`, or keep `true` with a one-line comment stating the task is intentionally vacuous until runtime e2e lands.

### S1-F3 · Low — eslint boundaries over-permit `web/mobile/desktop → db`

**Evidence:** `eslint.config.mjs:116-125` allows the three client apps to import `db`. Spec §6 grants db access to the server only; no app imports `@prisms/db` today (verified by grep). If one ever does, the `postgres` driver and Drizzle schema land in a client bundle and the server schema leaks client-side.

**Suggested change:** remove `'db'` from the allow lists of `web`, `mobile`, `desktop`. (Keep `server → db`.) If web e2e ever needs db types, e2e files are outside `src/` and can be granted separately.

### S1-F4 · Low — §15 verification commands not all exposed as root scripts

**Evidence:** spec §15 requires repo equivalents for `test:property`, `test:integration`, `test:e2e`, `test:recurrence`, `test:export`, `test:perf`, `build`. Root `package.json:10-16` exposes only `lint`, `typecheck`, `test`, `test:convergence`, `ci`. The capabilities all exist (property tests inside core's `test`, integration suites in server/db, `pnpm --filter @prisms/web e2e`, perf test in core, `--filter @prisms/web build`) but are not discoverable at the root, which is what the spec asks for ("the repo must provide equivalents").

**Suggested change:** add thin root aliases, e.g. `"test:integration": "pnpm --filter @prisms/db --filter @prisms/server test"`, `"test:e2e": "pnpm --filter @prisms/web e2e"`, `"test:perf": "pnpm --filter @prisms/core test -- status-index-perf"` (match the actual perf test file name — confirm in S2), `"build": "turbo run build"`. Alternatively document the mapping in README; aliases are cheaper than doc drift.

### S1-F5 · Info — `@types/node` major skew across workspace

**Evidence:** core `^24.0.0`, db `^24.13.2`, ui `^25.9.3`, server `^25.9.3`. Two majors of Node type definitions in one workspace; CI and prod run Node 24.

**Suggested change:** align all four on `^24` (matching the CI/prod runtime) unless something specifically needs 25-era types. Cosmetic, prevents "works in one package, red squiggle in another" type drift.

### S1-F6 · Medium (runtime risk, verify in S9) — workspace-wide React override `19.2.7` vs Expo 53 / RN 0.79 pairing

**Evidence:** `pnpm-workspace.yaml:13-18` force-overrides `react: '19.2.7'` for the whole workspace so shared `@prisms/ui` hooks resolve one React instance. `apps/mobile/package.json` declares `react ^19.0.0` with `react-native ^0.79.0` (Expo 53's official pairing is React 19.0.x). React Native's bundled renderer is compiled against an exact React version; forcing 19.2.7 under RN 0.79 can violate the react/renderer version invariant at runtime (a class of failure that typecheck/lint — the only verification mobile has had — cannot catch).

**Suggested change:** Session 9 must run `npx expo-doctor` / an actual Expo build to confirm or refute. If it breaks: prefer aligning the override to the Expo-supported React and letting web use the same version (web is not version-sensitive within 19.x), or restructure so mobile is excluded from the singleton requirement. Record the outcome either way; today "mobile runtime never verified" is the standing caveat.

### S1-F7 · Low — web client's PowerSync default port (8081) contradicts compose default (8080)

**Evidence:** `.github/workflows/ci.yml:71-76` carries a workaround: "The web client defaults powersyncUrl to :8081 (apps/web/src/config.ts — the maintainer's dev port). Map the powersync container to 8081…" i.e. CI remaps infrastructure to fit a personal default. A fresh clone running `docker compose up` + `pnpm dev` gets a client silently pointed at a port nothing listens on.

**Suggested change:** change the default in `apps/web/src/config.ts` to 8080 to match compose; keep the maintainer's 8081 as a local env override (`VITE_POWERSYNC_URL` or the existing `PRISMS_POWERSYNC_PORT` convention). Then delete the CI remap and its comment. Verify the exact config mechanism in Session 9 before changing.

### S1-F8 · Info — accepted deviation: no `packages/adapters`; ports live in `packages/ui/src/adapters/`

**Evidence:** spec §6 lists a `packages/adapters` workspace for provider-neutral ports. The implementation put the `SecureStorage`/`DbEncryption` ports in `packages/ui/src/adapters/` with concrete impls in apps (M13/M14 decision). R14's substance holds: core has zero provider deps (its only deps are `fractional-indexing`, `rrule`, `uuid`, `zod`), and provider SDKs (expo-secure-store, web-push, expo-server-sdk) live in apps/server only.

**Suggested change:** none required. Record as accepted deviation; optionally amend the Blueprint §6 diagram so the spec matches reality. S8 re-verifies the ports are genuinely provider-neutral.

### S1-F9 · Info — Node version alignment relies on convention, not tooling

**Evidence:** root `engines.node: ">=20"` (no upper bound), CI pins Node 24, prod Dockerfile node:24, local dev runs Node 26 (which requires rebuilding `better-sqlite3` from source — recurring friction documented in the project's history).

**Suggested change:** commit an `.nvmrc` (or Volta pin) with `24` so contributors land on the CI/prod version by default, and note the Node-26 better-sqlite3 rebuild in SELF_HOSTING/README dev docs (S10 checks whether it's already there).

---

## Positive observations (things later sessions can lean on)

- `tsconfig.base.json` is maximal-strictness (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noImplicitOverride`, unused-locals/params) — R8's "explicit contracts" has teeth.
- `eslint.config.mjs` core-purity block bans `Date.now`, `Math.random`, zero-arg `new Date()`, timers, fetch/XHR/WS, storage, `node:*` imports in `packages/core/src` — §16/§4 purity is mechanically enforced, and a grep confirms core imports no workspace package.
- CI (`ci.yml`) is a genuinely spec-shaped matrix: coverage floor ≥90% on core, integration vs fresh-volume compose Postgres + PowerSync, e2e vs a live stack with migrations applied *before* PowerSync boots (with the replication rationale documented inline).
- `pnpm-workspace.yaml` overrides are documented with reasons (drizzle peer dedup, React singleton) — rare hygiene.
- Migrations `0000_init` → `0008_v13_convergence` are forward-only and match the migration plan's account.

## Matrix updates made

R8 ✅, R14 ✅ (manifest level), §5 stack ✅, §6 layout ⚠️(F8), §6 lint rules ⚠️(F3), §15 commands ⚠️(F4). All other rows remain 🔎 with owning sessions.

**Next:** Session 2 — core primitives (`time/hlc`, `merge/*`, `sync/*`, `status/*` incl. the incremental StatusIndex) against §7.9–§7.12/§9.1, V7/V9.
