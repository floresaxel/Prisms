# Prisms Full-Codebase Audit — Plan & Tracker

**Goal.** Verify the implementation complies with the intended feature set — ARCHITECTURE_1.3.md (+ its 1.4 fixes) and CHANGE_SPEC_v1.0_to_v1.4.md — and that the code design is efficient. Produce a detailed findings report with suggested changes.

**Scope of "intended features."**
- Normative: `Blueprints/other/ARCHITECTURE_1.3.md` (R1–R20, V1–V12, §§7–13, §15 gates, §16 Definition of Finished) and `Blueprints/other/CHANGE_SPEC_v1.0_to_v1.4.md` (incl. 1.4 Fix A §7.14 and Fix C §7.15).
- **Not** in scope as requirements: `ARCHITECTURE_1.3_ANNEX_A_RECOMMENDATIONS.md` (A1–A8). The change-spec never adopted them (verified Session 1). They are treated as a candidate backlog, prioritized in Session 10.

**Method.**
- Audit sessions are **report-only**: findings + suggested changes, no code edits. Fixes are batched after the user reviews the reports.
- Every finding gets an ID (`S<n>-F<m>`), a severity, evidence (`file:line`), and a concrete suggested change.
- Severity: **Critical** (data loss/divergence/security hole), **High** (spec violation with user-visible effect), **Medium** (spec deviation, correctness risk, or real footgun), **Low** (hygiene, efficiency, hardening), **Info** (accepted deviation / observation).
- Central register: `docs/audit/00-feature-matrix.md` (requirement → evidence → status → owning session).
- **Parallel execution:** the full per-session work orders (objectives, scope, checklists, report template) live in `Blueprints/AUDIT_PLAYBOOK.md`, written so sessions 2–10 can run as independent LLMs concurrently. In that mode each session writes **only** its own `session-0N-*.md` (no shared-file edits); a final **Synthesis** run dedups findings across reports, resolves handoffs, updates this tracker + the matrix, and writes `docs/audit/FINAL_REPORT.md`. Sequential runs may update the matrix directly as originally planned.

## The 10 sessions

| # | Session | Scope (files) | Spec anchors | Status |
|---|---------|--------------|--------------|--------|
| 1 | **Foundation & tooling** | root configs, all 7 manifests, eslint boundaries/purity, turbo, CI workflows, repo layout, feature-matrix setup | §5, §6, §15, §16, R8, R14 | ✅ done — `session-01-foundation.md` |
| 2 | **Core primitives** | `packages/core/src/{time,merge,sync,status}` + their tests | §7.9–§7.12, §9.1, V7, V9, R15/R16 contracts | ⬜ pending → `session-02-core-primitives.md` |
| 3 | **Core engines** | `packages/core/src/{commands,rules,scheduler,aggregates,graph,domain}` + tests | §7.4–§7.6, §8, §9.2, §10 (pure), §11 | ⬜ pending → `session-03-core-engines.md` |
| 4 | **Server dispatcher & trust** | `apps/server/src/{dispatcher,app,auth,env,rate-limit,request-log,main,index}.ts` | §7.2b–e, §7.5, §7.8, §7.11, §10.1, R6, R17, R18, V2–V4 | ⬜ pending → `session-04-server-dispatcher.md` |
| 5 | **Server jobs** | `apps/server/src/jobs/*` | §7.4, §7.5, §10.2, §10.3, §12, §13.1, V6, V11, R18, R19 | ⬜ pending → `session-05-server-jobs.md` |
| 6 | **DB schema & sync topology** | `packages/db/*` (schema, 9 migrations, seed, CLI), `infra/powersync/*`, `docker-compose*.yml`, `infra/postgres/*` | §7.1, §7.3 (Tier 0/1/2, V8), §7.7, §7.8, §7.11, R5 | ⬜ pending → `session-06-db-sync.md` |
| 7 | **Client write path (two-layer store)** | `packages/ui/src/powersync/*` (overlay-store, effects, execute, commands, connector, upload-commands, client-runtime, schema, streams, rows) | §7.2/§7.2a–e, R15, V1–V2, DoF 1–6 | ⬜ pending → `session-07-client-write-path.md` |
| 8 | **Client read path & shared UI** | `packages/ui/src/{hooks.ts,powersync/data-provider.tsx,provenance.ts,worklist-grouping.ts,components,portability,adapters}` | §7.14 (Fix A), §7.15 (Fix C), §7.8, §13.1–§13.3 client side | ⬜ pending → `session-08-client-read-path.md` |
| 9 | **Apps: web / mobile / desktop** | `apps/web/src/*` (13 screens, config, portability, powersync), `apps/web/e2e/*`, `apps/mobile/*`, `apps/desktop/*` | §12 surfaces, M9/M10 interaction surfaces, §13.2, R1, R13, DoF 21/23 | ⬜ pending → `session-09-apps.md` |
| 10 | **Security, perf, docs + consolidated report** | `docs/SECURITY_REVIEW.md` re-verification, 100k budgets, convergence 13 scenarios vs §15, README/SELF_HOSTING accuracy, prod compose, `scripts/*`, Annex A prioritization, **final consolidated report** | §13, §15, §16 (all 23), Annex A | ⬜ pending → `session-10-security-perf-docs.md` + `FINAL_REPORT.md` |

## How to run the next session

Sequential: say e.g. *"run audit session 2"*. Parallel: dispatch each session with the prompt from the cheat-sheet at the bottom of `Blueprints/AUDIT_PLAYBOOK.md`, then run the Synthesis once all reports exist. Either way each session produces `docs/audit/session-0N-<name>.md`; the consolidated conclusion lands in `docs/audit/FINAL_REPORT.md`.

## Baseline (Session 1, 2026-07-01)

- Audited at commit `2ab3bf7` on branch `m0-spike` (clean tree).
- Gate `pnpm turbo lint typecheck test`: 21/21 tasks green — **via full turbo cache replay** (253 ms). Cached logs show mobile/desktop test tasks pass with zero test files and all 11 server integration suites (109 tests) skipped locally without Postgres; CI's `stack`/`e2e` jobs run them for real against compose Postgres + PowerSync.
