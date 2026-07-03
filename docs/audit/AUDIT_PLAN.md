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
| 2 | **Core primitives** | `packages/core/src/{time,merge,sync,status}` + their tests | §7.9–§7.12, §9.1, V7, V9, R15/R16 contracts | ✅ done — `session-02-core-primitives.md` (F1–F9; 3 Medium) |
| 3 | **Core engines** | `packages/core/src/{commands,rules,scheduler,aggregates,graph,domain}` + tests | §7.4–§7.6, §8, §9.2, §10 (pure), §11 | ✅ done — `session-03-core-engines.md` (F1–F9; **2 High**: weather gates clock-in V10, effective-hours double-count §9.2) |
| 4 | **Server dispatcher & trust** | `apps/server/src/{dispatcher,app,auth,env,rate-limit,request-log,main,index}.ts` | §7.2b–e, §7.5, §7.8, §7.11, §10.1, R6, R17, R18, V2–V4 | ✅ done — `session-04-server-dispatcher.md` (F1–F10; V2/V3/V4 verified ✅; Mediums: floor bypass, 100k write-path cliff, empty effects channel, dev-secret warn-only, auth rate limiting) |
| 5 | **Server jobs** | `apps/server/src/jobs/*` | §7.4, §7.5, §10.2, §10.3, §12, §13.1, V6, V11, R18, R19 | ✅ done — `session-05-server-jobs.md` (F1–F10; Mediums: review-expire unwired, replaces_block_id never set → accept double-books, 15-min notification spam, canonical hours double-count confirmed; V11/R18 ✅, import security checks ✅) |
| 6 | **DB schema & sync topology** | `packages/db/*` (schema, 9 migrations, seed, CLI), `infra/powersync/*`, `docker-compose*.yml`, `infra/postgres/*` | §7.1, §7.3 (Tier 0/1/2, V8), §7.7, §7.8, §7.11, R5 | ✅ done — `session-06-db-sync.md` (F1–F6; schema layer excellent, stream security airtight; Mediums: tier split nominal, command_results unreadable, client schema omits hlc; 7 handoffs resolved) |
| 7 | **Client write path (two-layer store)** | `packages/ui/src/powersync/*` (overlay-store, effects, execute, commands, connector, upload-commands, client-runtime, schema, streams, rows) | §7.2/§7.2a–e, R15, V1–V2, DoF 1–6 | ✅ done — `session-07-client-write-path.md` (F1–F9; **2 High**: offline spawning absent R4, >100-pending upload wedge; V1/V2/R6/R15 ✅; 3 §7.2d steps skipped) |
| 8 | **Client read path & shared UI** | `packages/ui/src/{hooks.ts,powersync/data-provider.tsx,provenance.ts,worklist-grouping.ts,components,portability,adapters}` | §7.14 (Fix A), §7.15 (Fix C), §7.8, §13.1–§13.3 client side | ✅ done — `session-08-client-read-path.md` (F1–F6; Fix A/C exact; Mediums: full rebuild per change at the StatusIndex seam, ROWS_CACHE never cleared on logout; PBKDF2 mis-cite; **S6-F3 corrected/downgraded**) |
| 9 | **Apps: web / mobile / desktop** | `apps/web/src/*` (13 screens, config, portability, powersync), `apps/web/e2e/*`, `apps/mobile/*`, `apps/desktop/*` | §12 surfaces, M9/M10 interaction surfaces, §13.2, R1, R13, DoF 21/23 | ✅ done — `session-09-apps.md` (F1–F6; **2 High**: no disconnectAndClear on logout → cross-account replica+command leak; mobile export calls missing crypto.subtle; S1-F6 CONFIRMED unsupported pairing w/ root cause, S1-F7 confirmed) |
| 10 | **Security, perf, docs + consolidated report** | `docs/SECURITY_REVIEW.md` re-verification, 100k budgets, convergence 13 scenarios vs §15, README/SELF_HOSTING accuracy, prod compose, `scripts/*`, Annex A prioritization, **final consolidated report** | §13, §15, §16 (all 23), Annex A | ✅ done — `session-10-security-perf-docs.md` (F1–F9; prod compose/scripts solid, PS_JWT mapping ✅; SECURITY_REVIEW overstates 2 controls; §15 gate map: 3 gates test the primitive not the product; 13/13 scenarios green vs live PG) + **`FINAL_REPORT.md` (Synthesis: 0 Critical · 6 High re-verified · 48 distinct findings · scorecard R 12✅/8⚠️ · V 6✅/6⚠️ · DoF 12✅/11⚠️ · 7-batch remediation backlog)** |

## Status: AUDIT COMPLETE (2026-07-02)

All 10 sessions + the Synthesis are done. The consolidated conclusion — executive summary, compliance scorecard, 48-finding register (0 Critical, 6 High, all re-verified), 7-batch remediation backlog, test-gap appendix, and the Annex A adoption recommendation — is **[FINAL_REPORT.md](FINAL_REPORT.md)**. Remediation is intentionally NOT started (report-only mandate); Batch 0 of the backlog is a set of product decisions to make before any code changes.

Dynamic evidence at close: repo gate 21/21 · server integration **114/114 vs live Postgres** (incl. all 13 convergence scenarios) · core coverage 537 tests, 90.58/93.8/93.65 (≥90 floor).

## Baseline (Session 1, 2026-07-01)

- Audited at commit `2ab3bf7` on branch `m0-spike` (clean tree).
- Gate `pnpm turbo lint typecheck test`: 21/21 tasks green — **via full turbo cache replay** (253 ms). Cached logs show mobile/desktop test tasks pass with zero test files and all 11 server integration suites (109 tests) skipped locally without Postgres; CI's `stack`/`e2e` jobs run them for real against compose Postgres + PowerSync.

## Remediation (2026-07-03, `Blueprints/REMEDIATION_PLAYBOOK.md`)

The 48-finding register was remediated across sessions R1–R10 (self-contained work orders in the playbook). Per-session logs: `docs/audit/remediation/session-rN.md`.

| Session | Commit | What landed |
|---|---|---|
| R1 hygiene+spec | `a9a2a5f` | turbo env keys, §15 aliases, eslint boundaries, nginx headers, 3-stage Dockerfile, PWA icons, spec amendments (D1/D2/D5) |
| R2 status semantics | `05a3bc6` | **S3-F1 (High)** weather out of acceptance; SS/SF lag; weather-conditioned automations rejected |
| R3 hours correctness | `3a243c9` | **S3-F2 (High)** union-not-sum through `mergeTimeEntries` on every aggregate |
| R4 jobs lifecycle | `643f223` | review-expire wired; `replaces_block_id` (no double-book); notify-once; template versioning |
| R6 upload+versions | `a7e7a2b` | **S7-F2 (High)** upload chunking; versions end-to-end + server floor; poison-batch isolation |
| R7 StatusIndex client | `d8eaecc` | **S8-F1 (High)** incremental provider; fan-out scoping (S2-F4/F5) |
| R8 server scale+effects | `63c284e` | **S4-F2** per-batch context cache (17.6× at 100k); **S4-F3** `command_log.effects` |
| R9 account+mobile | `ee02580` | **S9-F1 (High)** logout boundary; **S9-F2 (High)** mobile crypto; React pairing (S9-F3); PBKDF2 600k (S8-F3); desktop CSP |
| R10 topology+docs+sign-off | *this branch* | **S6-F1/F2/F4** tier substance + drop `command_results` + scoped publication; **S4-F4/F5/F6 + S10-F5** boot fail-fast/JWK check, rate + body limits; **S3-F7** `matches` cap; **S2-F2** additive-schema gate; **S10-F3a** two-user isolation test; docs truth-up (S10-F1/F2) |

**High-finding status: 5 of 6 closed.** S3-F1 (R2, server) · S3-F2 (R3) · S7-F2 (R6) · S9-F1 (R9) · S9-F2 (R9, device-verify pending). **Outstanding: S7-F1 (offline automation spawning) — R5 (write-path parity) is NOT yet done.** R5 is disjoint from R6/R7/R8 (which only needed R2/R4), so it was skippable in the wave order but is a hard prerequisite for the final release sign-off.

**R10 sign-off gate (on the `r10-topology-signoff` head = `remediation` + R6/R7/R8/R9/R10, missing R5):** `pnpm turbo lint typecheck` 14/14 · core **559** tests, coverage **90.44/94.02/93.39** (≥90) · db **49** · server **125** + api **14** (live PG, incl. convergence 15/15 + two-user isolation) · web build ✅. e2e = CI. **The `remediation`→`m0-spike` merge is HELD pending R5 (S7-F1 High) + operator approval.**
