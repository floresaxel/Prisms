# Prisms Remediation Playbook — 10 Parallel Sessions + Integration Protocol

This is a **self-contained work order**. Each session R1–R10 below can be handed to a separate LLM (or run sequentially) with no other context than this file, the repository, and the audit reports it cites. It remediates the findings of the completed 10-session audit (`docs/audit/FINAL_REPORT.md`, sessions `docs/audit/session-01…10-*.md`), whose 48 findings (0 Critical, 6 High) this playbook maps 1:1 onto sessions — coverage matrix in §0.8.

---

## 0. Shared context (read this whole section before running any session)

### 0.1 What you are fixing

Prisms is a local-first, multi-device planning app: web (Vite/React/PWA), desktop (Tauri wrapping the identical web build), mobile (Expo RN), Hono/Node server over Postgres, PowerSync Sync Streams. All mutations are named command envelopes (never row patches); the client store is a read-only synced replica + a local-only optimistic overlay, read as a deterministic merge; status is derived (never stored); HLCs order everything. The audit confirmed this architecture is real; the defect pattern is **"correct primitive, unwired product path"** — several finished, tested mechanisms have no production consumer. Most sessions below *wire what exists* rather than build new machinery.

### 0.2 Inputs you must read first (per session; listed in each section)

- `docs/audit/FINAL_REPORT.md` — consolidated register, severity, remediation batches.
- The per-session audit reports cited in your section — they contain the exact `file:line` evidence and failure scenarios. **Do not re-derive the diagnosis; do re-verify the cited lines before editing** (the code may have moved since baseline `2ab3bf7`).
- Spec: `Blueprints/other/ARCHITECTURE_1.3.md` (+ `CHANGE_SPEC_v1.0_to_v1.4.md`) for the sections your findings cite.

### 0.3 Ground rules (every session)

1. **Own your files.** Each session lists OWNED files (edit freely), SHARED-HOTSPOT files (edit only the named region; see §0.6), and FORBIDDEN files (do not touch — another session owns them). This is what makes parallel merges clean.
2. **Branch per session:** `r0N-<slug>` cut from the integration branch head (§0.5). One session = one branch = one logical commit series. Commit message prefix: `fix(rN): …` (or `docs(rN):` / `test(rN):`).
3. **Tests are part of the fix.** Every behavioral change lands with the test named in your section. A fix whose pinning test doesn't fail *before* the fix (where feasible: write test → see red → fix → green) should say so in the session log.
4. **Session log:** write `docs/audit/remediation/session-rN.md` (your own file; never edit another session's log or this playbook): findings addressed, decisions taken, gate evidence (paste the final test-run tails), deviations from this plan and why, anything discovered out-of-scope (report, don't fix).
5. **Gate before handoff:** `pnpm turbo lint typecheck test` (21 tasks) green, plus your section's targeted suites. **Warning (until R1 lands):** turbo's cache is blind to `PRISMS_DB_TEST_URL` (audit S1-F1) — run integration suites via `pnpm --filter @prisms/server test` / `--filter @prisms/db test` directly, never trust a 250 ms cached replay.
6. **Scope discipline.** If your fix seems to require editing a FORBIDDEN file, stop and record it in your log as an integration note instead of editing. If you find a *new* bug, log it under "out-of-scope findings"; don't chase it.
7. **No spec drift.** Where a fix changes user-visible semantics (R2's force rule, R6's version rejection), update the code comment at the site *and* note the Blueprint section in your log; R1/R10 own the actual Blueprint/docs edits.

### 0.4 Environment (this machine; adapt if elsewhere)

- Windows; use PowerShell (the Bash tool is broken here). Repo root: `C:\Users\Flore\OneDrive\Documents\Claude\Projects\Prisms_alpha`.
- Postgres for integration tests: WSL docker compose — `wsl docker compose up -d` (pin WSL with a background `wsl sleep`), then
  `$env:PRISMS_DB_TEST_URL = 'postgresql://prisms:prisms_dev_password@127.0.0.1:5434/prisms'` (connect via 127.0.0.1, not localhost; host port 5434 via `.env`).
- Node 26 locally → `better-sqlite3` must be rebuilt from source (node-gyp) or ui/server sqlite-backed tests fail to load. CI uses Node 24.
- Full verification set: `pnpm turbo lint typecheck test` · `pnpm --filter @prisms/server test` (integration, needs PG) · `pnpm --filter @prisms/db test` · `pnpm test:convergence` · `pnpm --filter @prisms/core test:coverage` (≥90 floor) · `pnpm --filter @prisms/web e2e` (needs the full stack; usually leave to CI/R10).

### 0.5 Branching & integration model

- **Integration branch:** `remediation`, cut once from `m0-spike` at the commit that adds this playbook (so every session branch contains it). All session branches cut from — and merge back to — `remediation`. (`m0-spike`/`main` stay untouched until R10 signs off.)
- **Waves** (respect the dependency arrows; parallel within a wave):
  - **Wave 1 (parallel):** R1 · R2 · R3 · R4 · R9
  - **Wave 2 (after R2 merges; parallel):** R5 (also prefers R4 merged) · R6 · R7
  - **Wave 3 (after R2/R4/R6 merged):** R8
  - **Wave 4 (after everything):** R10 (doubles as the integration finalizer)
- **Merge protocol (integrator or each session at handoff):** rebase your branch onto current `remediation` → re-run your section's gate → fast-forward/merge → integrator re-runs `pnpm turbo lint typecheck test` + `pnpm --filter @prisms/server test` after *every* merge. Merge order within a wave: by session number.
- **Conflict rule:** conflicts should only occur in the declared shared hotspots (§0.6). If you hit one elsewhere, someone broke §0.3.1 — stop and reconcile by re-reading both sessions' scopes, keeping both intents (never discard the other branch's change).

### 0.6 Shared-hotspot register (the only files two+ sessions may touch)

| File | Sessions (rebase order) | Region split |
|---|---|---|
| `apps/server/src/dispatcher.ts` | R2 → R4 → R6 → R8 | R2: the `timer.clock_in` blocked-gate (~:697-700) only · R4: `stampProv` (~:276-288) only · R6: floor check (~:1293) + `handleCommand` catch (~:1349-1355) only · R8: context loaders (~:185-231, :402-405) + `command_log` inserts + handler effect summaries (wide; hence last) |
| `packages/core/src/status/status-index.ts` | R2 → R7 | R2: add `earliestEntryStart` bookkeeping only · R7: fan-out scoping + unknown-row guard + anything else |
| `packages/core/src/rules/validate.ts` | R2 → R10 | R2: reject external-fact namespaces in conditions · R10: regex complexity cap |
| `packages/ui/src/hooks.ts` | R3 → R9 | R3: the dashboard today-total aggregation (~:726) only · R9: cache-clear export near `ROWS_CACHE` (~:120-156) only |
| `packages/ui/src/powersync/overlay-store.ts` + `upload-commands.ts` + `schema.ts` (client) | R6 only | — (R5 must NOT touch these; R5 owns `execute.ts`/`commands.ts`/`effects.ts`, R6 must not touch those) |
| `apps/server/test/convergence.integration.test.ts` | R2, R3, R4, R6 (append-only) | each session APPENDS new scenarios/assertions at the end of the file or extends only its named scenario; never renumber or reorder existing scenarios |
| Root configs (`turbo.json`, `package.json`, `eslint.config.mjs`, CI) | R1 → R10 | R1: hygiene items only · R10: CI job additions only. **Nobody else.** `pnpm-workspace.yaml` is owned by R9 (React override removal) — R1 must not touch it. |

### 0.7 Batch-0 decisions — RATIFIED DEFAULTS (operator may veto before dispatch; sessions implement these without asking)

| # | Decision | Ratified default | Consumed by |
|---|---|---|---|
| D1 | Double clock-in survivor (§7.10b letter says earliest-wins + `superseded` marker; code/harness/UX = latest-wins, no marker) | **Bless latest-wins.** Amend §7.10b text; no code change; drop the `superseded`-marker requirement (provenance via `ended_at` + command log is sufficient) | R1 (spec edit) |
| D2 | Sibling-order tiebreak (§7.10a says `(sort_order, hlc)`; client schema has no `hlc`; UI uses `(sort_order, id)` — deterministic + convergent) | **Bless `(sort_order, id)` for display**; canonical server order stays `(sort_order, hlc)`. Amend §7.10a note. `layout.renormalize_order` stays in the catalog, documented as maintenance-only (no auto-trigger) | R1 (spec edit) |
| D3 | `command_log.effects` / `parent_command_id` / `triggering_command_id` never written (§7.2f, R9) | **Populate** (don't drop): compact per-command effect summaries + `triggering_command_id` on automation attribution — R9 is a hard requirement and undo groundwork | R8 |
| D4 | User-facing history retention vs the 90-day purge (S5-F7) | **Document “history window = 90 days”** for v1 (SELF_HOSTING + a Blueprint note); Annex A5 (compaction/redaction) is the post-v1 vehicle for longer retention | R1 (doc), R10 (SELF_HOSTING) |
| D5 | `node.retype` cascade-plan payload (§8) vs rejection-only | **Rejection-only**; amend §8 (workaround: move/retype children first) | R1 (spec edit) |
| D6 | DoF 23 (platform smoke tests or accepted exception) | Fix mobile blockers (R9), run the existing Maestro flow once on a device/emulator; if green, accept the “dedicated-runner” exception for v1 and record it | R9 (run), R10 (record) |
| D7 | Envelope-version enforcement rollout (server rejecting version-less commands would lock out any not-yet-updated installed client) | Land client-first and server-second **in the same release** (pre-GA this is safe); R6 must ship the client change in an earlier commit than the server change, and note in SELF_HOSTING that installed clients must update before/with the server | R6, R10 |
| D8 | `E_NOT_FOUND` vs `E_OWNERSHIP` distinct codes (S4-F10 oracle) | Keep distinct (UUIDs make the oracle negligible; the distinction aids debugging). Record as accepted | R1 (record) |

### 0.8 Findings → session coverage matrix (all 48 register entries)

| Session | Findings (register IDs) |
|---|---|
| R1 | S1-F1, S1-F2, S1-F3, S1-F4, S1-F5, S1-F9, S9-F4, S10-F4, S10-F6, S10-F7, S10-F9 + decisions D1/D2/D4/D5/D8 spec/docs edits (S2-F1, S8-F4, S3-F6, S5-F7, S4-F10) + accepted-deviations record (S1-F8, S5-F9, S6-F6) |
| R2 | **S3-F1 (High)**, S3-F5, S3-F8, S5-F10 + harness scenario 13b |
| R3 | **S3-F2 (High)**, S5-F4, S2-F9 (note-only unless trivial) + scenario-9 aggregate assertion |
| R4 | S5-F1, S5-F2, S5-F3, S5-F5, S5-F6 (quick wins), S3-F4 (+S5-F8, S8-F5) + accept-double-book scenario |
| R5 | **S7-F1 (High)**, S7-F4 (=S3-F3), S7-F5, S7-F7 |
| R6 | **S7-F2 (High)**, S7-F3 + S4-F1 (coupled, ordered), S7-F6, S7-F8, S7-F9, S4-F8 + 150-pending + absent-version tests |
| R7 | S2-F4, S2-F5, S8-F1 (client half of W1: S2-F3) |
| R8 | S4-F2 (server half of W1), S4-F3 (per D3), S4-F7 (stretch), optional Annex-A2 skew guard (stretch) + server 100k write-path perf test |
| R9 | **S9-F1 (High)** (+S8-F2), **S9-F2 (High)**, S9-F3, S8-F3, S9-F5 + D6 device run |
| R10 | S6-F1, S6-F2, S6-F4, S4-F4 (+S10-F5), S4-F5, S4-F6, S3-F7, S2-F2 (=S6-F5), S10-F1, S10-F2, S10-F3a (isolation test), S10-F8 (record D6), cold-start measurement, CI additions, final integration sign-off |

---

## Session R1 — Hygiene sweep + spec reconciliation (no behavior change)

**Wave 1 · Log:** `docs/audit/remediation/session-r1.md` · **Read first:** audit S1 report; S10 report F4/F6/F7/F9; FINAL_REPORT §2 “accepted deviations”; §0.7 D1/D2/D4/D5/D8.

**Objective:** land every zero-risk config/doc fix and write the ratified decisions into the Blueprints, so later sessions inherit an honest gate and a reconciled spec. Nothing in this session changes runtime behavior (Dockerfile/nginx changes affect packaging only).

**Steps:**
1. `turbo.json`: add `"env": ["PRISMS_DB_TEST_URL", "PRISMS_POWERSYNC_URL"]` to the `test` task (S1-F1).
2. Root `package.json`: add §15 aliases — `test:integration` (db+server filtered), `test:e2e` (web e2e), `test:perf` (`pnpm --filter @prisms/core test -- load.perf`), `build` (`turbo run build`) (S1-F4).
3. `apps/web/vitest.config.ts`: `passWithNoTests: false`; mobile/desktop keep `true` with a one-line comment (S1-F2).
4. `eslint.config.mjs`: remove `db` from web/mobile/desktop boundary allow-lists; keep `server → db` (S1-F3). Run lint to prove nothing imported it.
5. Align `@types/node` on `^24` in core/db/ui/server (S1-F5); add `.nvmrc` with `24` (S1-F9).
6. `apps/web/src/config.ts`: default PowerSync URL port 8081 → **8080**; delete the CI remap env + comment block in `.github/workflows/ci.yml` (e2e job `PRISMS_POWERSYNC_PORT: 8081` + its comment) (S9-F4). Keep 8081 reachable via `VITE_POWERSYNC_URL`/`PRISMS_POWERSYNC_PORT` for local dev; note in README dev section.
7. `infra/nginx/web.conf` (S10-F4): add `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a CSP compatible with the SPA + `/powersync` WS + wasm (`wasm-unsafe-eval`), HSTS **commented with a “enable once TLS-terminated” note**; `location /assets/ { Cache-Control: public, max-age=31536000, immutable }`; explicit `no-cache` for `index.html` + `sw.js`.
8. `apps/server/Dockerfile` (S10-F6): lockfile-first layer (`pnpm-lock.yaml` + manifests → `pnpm fetch`), then source copy + offline filtered install; add a runtime stage so the image ships core+db+server only. Verify: `docker compose -f docker-compose.prod.yml build api` (or config-validate if docker unavailable; say which in the log).
9. `apps/web/vite.config.ts` (S10-F7): add PWA manifest icons (generate simple 192/512 + maskable PNGs under `apps/web/public/`); add `/powersync` to `navigateFallbackDenylist`.
10. Docs/spec edits: dev-compose stale TODO comment (S10-F9); `restore.sh` — add `$COMPOSE stop api` before restore + start after; Blueprints: amend §7.10b per **D1**, §7.10a per **D2**, §8 retype per **D5**, add the accepted-deviations note (no `packages/adapters`; §7.13 FK dropped; export-manifest field omissions; D4 history window; D8 codes). Mark each edit with `> Amended post-audit (R1, 2026-07):`.

**Owned files:** all named above + `Blueprints/other/ARCHITECTURE_1.3.md` (amendment blocks only). **Forbidden:** `pnpm-workspace.yaml` (R9), everything under `packages/*/src` and `apps/*/src` except `apps/web/src/config.ts`.
**DoD:** full gate green **with the env vars set and PG up** (this session makes that meaningful); CI yaml still valid (`gh workflow view` or YAML lint); log written.

---

## Session R2 — Core status semantics: weather out of acceptance + dependency-lag gates

**Wave 1 · Log:** `session-r2.md` · **Read first:** audit S3 report F1/F5/F8 (full evidence chains), S5-F10, S4 report “isBlocked single-site” resolution; spec §9.1, §10.3, §7.6, R19/V10.

**Objective:** external facts stop gating command acceptance (fixes High S3-F1); SS/SF lag semantics match §7.6 (S3-F5); weather predicates become invalid in automation conditions since they can never fire (S3-F8/S5-F10). This is the session that makes R19/V10 and DoF 22 true.

**Steps:**
1. `packages/core/src/status/predicate.ts`: export `referencesExternalFacts(predicate): boolean` — AST walk flagging any fact reference in the `weather.` (or future external) namespace. Unit-test on nested and/or/not trees.
2. `packages/core/src/status/status.ts`: add an acceptance-safe evaluation — either `evaluateBlockerRules(…, {excludeExternalFacts: true})` or `isBlockedForAcceptance(task, ctx, now)` = `dependencyBlocked ∨ non-external blockedBy`. **Display path (`taskStatus`/badges) unchanged** — weather still shows blocked/unverified.
3. `apps/server/src/dispatcher.ts` (~:699, your ONLY dispatcher region): switch the `E_BLOCKED_TASK` gate to the acceptance-safe call. Semantics after: weather-only-blocked task clocks in **without** `force`; dependency/non-external blocking still requires `force`. Update the §8 comment at the site.
4. `packages/core/src/rules/validate.ts`: `validateAutomationRule` rejects conditions referencing external-fact namespaces (reuse step 1’s walker), typed error (they can never fire server-side — S5-F10). Rejecting test.
5. S3-F5 lag gates: extend `FactContext` (`status/context.ts`) with `earliestEntryStart(nodeId)`; maintain it in `buildFactContext` **and** `StatusIndex` (`status-index.ts` — ONLY this bookkeeping; R7 owns the rest of the file). Enforce: SS availability lag in `status/status.ts` (started_at + lag), SF completion lag in `commands/invariants.ts` (started_at + lag; FS/FF already correct). Add the two missing lag tests (catalog SF-lag case; status SS-lag with started-not-completed predecessor).
6. Harness: **append scenario 13b** to `apps/server/test/convergence.integration.test.ts`: user has a weather blocker rule matching the task; server holds a “blocking” weather fact; non-force `timer.clock_in` → **applied** (was rejected before this session); a dependency-blocked task still rejects without force. Must fail before step 3, pass after.

**Owned:** `packages/core/src/status/{predicate,status,context}.ts`, `packages/core/src/commands/invariants.ts`, core tests for those. **Shared:** `dispatcher.ts` (one region), `status-index.ts` (bookkeeping only), `rules/validate.ts` (one check), harness (append-only). **Forbidden:** `rules/{engine,actions}.ts` (R4), aggregates (R3), everything in `packages/ui`.
**DoD:** core coverage still ≥90; server integration green incl. 13b; convergence 14/14; log notes the force-semantics change for R5 (client pre-flight must mirror it) and R10 (docs).

---

## Session R3 — Hours correctness: consume the union resolver everywhere

**Wave 1 · Log:** `session-r3.md` · **Read first:** audit S3-F2 + S5-F4 (both evidence chains), S2-F9; spec §9.2 (“effective hours must consume the timer-merge resolver”).

**Objective:** every hours/progress aggregate — client and server-canonical — unions overlapping intervals per task instead of summing per entry (fixes High S3-F2 + S5-F4 in one move, because both tiers call the same core functions).

**Steps:**
1. `packages/core/src/aggregates/practice.ts`: group entries per task → `mergeTimeEntries(taskEntries)` → sum union minutes across tasks (was per-entry `effectiveMinutes` sum). Preserve focus-factor handling exactly as `mergeTimeEntries` defines it.
2. `packages/core/src/aggregates/progress.ts`: same — per-task union for consumed minutes (raw and effective variants).
3. `packages/ui/src/hooks.ts` (~:726, your ONLY hooks region): dashboard today-total unions per task per day-bucket, keeping the live-elapsed add-on for the currently-open entry.
4. `packages/core/src/aggregates/effective.ts`: keep per-entry helpers for single-entry display but rename or doc-comment them so they can’t silently become an aggregation path again (`// per-entry display only — aggregation goes through mergeTimeEntries (§9.2)`).
5. Verify `apps/server/src/jobs/aggregates-recompute.ts` needs **no edit** (it calls `canonicalPractice` → fixed via step 1). If it has its own summation, that’s an integration note, not your edit (R4 owns jobs).
6. Tests: unit tests with the audit’s canonical case (09:00–11:00 + 09:30–10:30 closed pair → 120 raw union… careful: union of that pair is 150→no: 09:00–11:00 ∪ 09:30–10:30 = 09:00–11:00 = 120 min; naive sum = 150) at practice, progress, and hook levels; **extend harness scenario 9** (append assertions only): after sync, `canonicalPractice(...)`/progress output === union value (fails before, passes after). S2-F9 (O(N²) focus sweep): leave unless the union work touches it naturally; note in log.

**Owned:** `packages/core/src/aggregates/*`, their tests. **Shared:** `hooks.ts` (one region), harness scenario 9 (extend assertions only). **Forbidden:** `merge/time-entries.ts` semantics (consume, don’t change), jobs (R4), `status/*` (R2).
**DoD:** core coverage ≥90; server integration green (recompute tests now assert union values); convergence green; log records the before/after numbers for the canonical case.

---

## Session R4 — Server jobs lifecycle + automation attribution

**Wave 1 · Log:** `session-r4.md` · **Read first:** audit S5 report F1/F2/F3/F5/F6 + S3-F4/S5-F8/S8-F5 (template_version, three sites); spec §12, §10.2, §7.5.

**Objective:** wire the unwired job (S5-F1), stamp the suggestion replacement link so accepting a reschedule stops double-booking (S5-F2), stop notification spam (S5-F3), honest snapshots (S5-F5), and make V6’s version attribution real (S3-F4).

**Steps:**
1. `apps/server/src/jobs/boss.ts`: add a `reviewExpire` queue + weekly schedule mirroring `retentionPurge` (S5-F1). `retention-purge.ts`: add `sync_review_items`, `tags`, `tag_placements`, `tag_answers` to `PURGE_ORDER` (soft-deleted, respecting the 90-day rule).
2. `schedule-optimize.ts` (+`scheduler-context.ts` if the data lives there): when a proposal’s task has live *flexible committed* block(s) in the horizon (the same set placement un-obstacles — see `core/scheduler/placement.ts:171-174`), stamp the overlapped/earliest one as `replaces_block_id` on the suggested row (S5-F2). `pastdue-scan` untouched (exempt by construction).
3. `pastdue-scan.ts`: notify only when the `past_due_reschedule` suggestion is *first created* (move `enqueueNotify` inside the first-suggestion branch), or persist per-task `last_notified_at` — pick one, document it (S5-F3).
4. `aggregates-recompute.ts`: `db.transaction(fn, { isolationLevel: 'repeatable read' })` (S5-F5). Quick wins from S5-F6 *if cheap*: SQL-side due-date filter for pastdue; batch inserts in optimize/import; skip the cadence redesign (log it as deferred).
5. Template versioning (S3-F4): `packages/core/src/rules/actions.ts` — `export const TEMPLATE_VERSION = 1`; `rules/engine.ts` — extend `SpawnProvenance` with `rule_version`/`template_version`; `dispatcher.ts` `stampProv` (~:276-288, your ONLY dispatcher region) and `automation-backstop.ts` — stamp both into `source_detail`; backstop drift detail records both versions + both hashes. The ui provenance panel (`packages/ui/src/provenance.ts`) already reads these fields — **do not edit it** (S8-F5 lights up by itself).
6. Tests: jobs integration — review-expire scheduled (boss registration assert), replaces_block_id stamped, single notification per past-due task across two scan runs; **append harness scenario 14**: optimize-suggests-move → accept → old block soft-deleted, task not double-booked (fails before step 2). Engine unit test: spawn provenance carries both versions.

**Owned:** `apps/server/src/jobs/*`, `packages/core/src/rules/{actions,engine}.ts` + tests. **Shared:** `dispatcher.ts` (stampProv region), harness (append scenario 14). **Forbidden:** `rules/validate.ts` (R2), aggregates (R3), `packages/ui`.
**DoD:** server integration + jobs suites green; convergence green (now 15 scenarios); core coverage ≥90; log written.

---

## Session R5 — Client write-path completion (offline parity)

**Wave 2 (rebase on R2; prefer R4 merged for engine provenance) · Log:** `session-r5.md` · **Read first:** audit S7 report F1/F4/F5/F7 (+ S3-F3), S7’s “Resolved handoffs” table; spec §7.2d steps 2/4, §10.1 client half, R4.

**Objective:** `execute()` gains the three skipped §7.2d steps: invariant pre-flight (S7-F4), offline automation spawning (S7-F1 High), soft-delete closure (S7-F7), and `depends_on` derivation (S7-F5). One shared prerequisite: merged `FactRows` available at write time.

**Steps:**
1. Merged-facts plumbing: give `execute()` access to merged `FactRows`/`FactContext` at write time. Options (pick, justify in log): accept a context getter param wired from the data-provider at `createCommands()` time, or a lightweight direct query of replica+overlay inside the write txn. **Do not edit `data-provider.tsx`** (R7 owns it) — consume its existing exports only.
2. Invariant pre-flight (S7-F4): before writing effects, run the verb’s `check*` invariant against merged state; failure → immediate typed command error (no envelope, no overlay, no review item). **Mirror R2:** the clock-in pre-flight uses the acceptance-safe evaluator (weather never blocks locally either); `force: true` skips exactly what the server skips.
3. Offline spawning (S7-F1): when the verb implies `task_created`/`task_completed`, run core `runAutomations` against merged facts; validate spawns with the same I1/I3 checks the server uses; append spawn insert effects to the overlay **within the same enqueue transaction**. UUIDv5 spawn ids + (if R4 merged) version-stamped provenance predictions make server reconciliation byte-identical. Depth-limit behavior mirrors the engine default.
4. Soft-delete closure (S7-F7): compute `softDeleteClosure` over the merged tree; pass descendant `del` effects via the existing unused `extraEffects` mechanism (`execute.ts:52`); fix the stale comment at `effects.ts:123` and `commands.ts:49-53`.
5. `depends_on` (S7-F5): at enqueue, any payload row-id that matches a still-pending command’s inserted row id (query `overlay_effects` op='insert') becomes a dependency; store on the command row and include in the envelope. **Coordinate with R6:** the column + upload-body inclusion live in R6’s files (`overlay-store.ts`/`upload-commands.ts`/client `schema.ts`) — implement derivation + the enqueue *interface* here (pass `depends_on` into `enqueue()`), and if R6 hasn’t merged yet, land the derivation behind the interface and note the handshake in both logs.
6. Tests (ui): pre-flight rejects a second clock-in offline / an I1-violating move (no envelope written); completing a rule-bearing task offline inserts the spawned node into merged reads with predicted provenance, and after server sync the row reconciles identically (extend the existing overlay reconcile test); offline project delete hides the whole subtree from a flat merged read; edge.create on a pending node derives `depends_on=[nodeCmd.id]`.

**Owned:** `packages/ui/src/powersync/{execute,commands,effects}.ts`, ui tests. **Forbidden:** `overlay-store.ts`, `upload-commands.ts`, `connector.ts`, `client-runtime.ts`, client `schema.ts` (all R6); `data-provider.tsx`, `hooks.ts` (R7/R3/R9); core (consume only).
**DoD:** ui suite green (new tests listed in log); full gate green; convergence green; log records the R6 handshake state.

---

## Session R6 — Upload robustness + versions end-to-end

**Wave 2 (parallel with R5 — disjoint files; honor the §R5.5 handshake) · Log:** `session-r6.md` · **Read first:** audit S7 report F2/F3/F6/F8/F9, S4 report F1/F8; §0.7 **D7**; spec §7.2d–e, §7.11.

**Objective:** the upload queue survives real life (fixes High S7-F2), envelopes carry versions and the server enforces the floor (S7-F3 → S4-F1, **strictly in that commit order**, per D7), overlay reconciles on canonical arrival (S7-F6), HLC survives restarts (S7-F8), lifecycle leaks closed (S7-F9), poison commands can’t 500 a batch (S4-F8).

**Steps:**
1. Chunking (S7-F2): `upload-commands.ts` splits `pendingCommands()` into sequential ≤100-command batches (HLC order preserved; existing single-flight guard covers concurrency). Distinguish responses: 4xx → surface loudly (console.error + mark state so a future diagnostics screen can show it; do NOT retry-loop), network/5xx/429 → throw → existing retry. **Regression test: 150 pending → two batches → all applied.**
2. Versions, client first (S7-F3): extend the local `client_commands` table (client `schema.ts` — local-only table, no sync-schema impact) with `command_version`/`schema_version`/`client_version`; mint via core’s `defaultCommandMeta()` inside `overlay-store.enqueue()` (captures the minting version — better than upload-time); include in the upload body; accept `depends_on` from R5’s interface (column + envelope field). Commit this **before** step 3.
3. Server floor (S4-F1): `dispatcher.ts` (~:1293, your region): `const sv = cmd.schema_version ?? 0;` gate unconditionally → absent = below-floor = `E_CLIENT_TOO_OLD` + `schema_version_block` review item. Same normalization at the `command_log` insert defaults. **Append harness assertions:** a version-less envelope is rejected `client_too_old`; the harness `Device` now sends versions by default (update its envelope builder — append-only edits).
4. Reconcile-on-canonical-arrival (S7-F6): on `applied`/`noop` ack, keep effects and mark the command `applied` (tombstone); a reconciler drops effects once the canonical row arrives with `last_modified_by_command_id === command.id` (V2 identity makes this exact). Implement the reconciler as a self-contained watch inside `overlay-store.ts`/`client-runtime.ts` — **not** in `data-provider.tsx` (R7). Timebox: if the arrival check proves gnarly for delete-ops, fall back to per-table presence checks and document; the DoD is “no revert-flicker in the merged read between ack and sync-down” (test with a delayed fake download).
5. HLC persistence (S7-F8): `client-runtime.ts` seeds the clock from `max(persisted last-tick, max(client_commands.hlc), import floor)`; persist last-tick via the existing storage seam (same place as `HLC_FLOOR_KEY`).
6. Lifecycle (S7-F9): `startCommandUpload`’s stop disposes the `db.watch` subscription (SDK abort/dispose API); prune `rejected` command rows older than 30 days during reconcile passes.
7. Poison batch (S4-F8): wrap per-command execution (~:1349-1355) in try/catch → `rejected` `E_INTERNAL` + review item (txn already guarantees no partial effects); batch continues.

**Owned:** `packages/ui/src/powersync/{overlay-store,upload-commands,connector,client-runtime,schema}.ts`, ui tests. **Shared:** `dispatcher.ts` (floor + catch regions), harness (append + Device envelope builder), `packages/core/src/commands/envelope.ts` if `depends_on`/version fields need loosening (additive only). **Forbidden:** `execute.ts`/`commands.ts`/`effects.ts` (R5), `data-provider.tsx` (R7).
**DoD:** ui + server + convergence green; the two new regression tests red-before/green-after noted in log; D7 ordering visible in commit history; SELF_HOSTING client-update note handed to R10 in the log.

---

## Session R7 — StatusIndex wiring, client half

**Wave 2 (rebase on R2 — it touches `status-index.ts` first) · Log:** `session-r7.md` · **Read first:** audit S2 report F3/F4/F5/F7, S8 report F1 (the seam), S8’s positive-observations (what not to break); CHANGE_SPEC Fix A; `apps/web/test/data-provider.test.ts` + `packages/ui/test/read-layer.test.ts` invariants.

**Objective:** the incremental index becomes the live client path (the audit’s #1 efficiency workstream, client half): fan-out gaps closed first (S2-F4), then `data-provider.tsx` stops rebuilding the world per keystroke (S8-F1).

**Steps:**
1. Fan-out scoping (S2-F4), in core: phase-blocker fan-out → only descendants of projects actually referenced by phase predicates (the rule AST names them); weather fan-out → only tasks matched by weather-reading rules. `applyBlockerRule` full fan-out stays (rare, documented). Extend `load.perf.test.ts`: 100k + one phase blocker + one weather blocker enabled → per-command `apply` still < 16 ms, touch-set < its bound (this fails before the scoping fix — write it first).
2. Unknown-row guard (S2-F5): `applyOne` ignores `update` effects for rows the index doesn’t hold (no `toNode` fabrication); count via an instrumentation hook; document inserts as the only unknown-row path.
3. Provider wiring (S8-F1), `packages/ui/src/powersync/data-provider.tsx`: maintain a `StatusIndex` (+ tree/context view) fed by diffs instead of rebuilding `buildFactContext` on every change. Implementation latitude, but the DoD is behavioral: **(a)** `buildFactContext` runs once per session (plus explicit resets: import, `disconnectAndClear`), not per data change — pin with a spy test; **(b)** the provider’s public API (`factContext/tree/rows/isFetching/isHydrated`) is unchanged — all existing consumers compile untouched; **(c)** the read-layer test’s subscription-count invariant and the now-tick no-rebuild test still pass; **(d)** status values equal the rebuild path’s (property test: random effect stream → index view === fresh `buildFactContext` + `taskStatus`, reusing the S2 equivalence-test pattern at the provider level). PowerSync `useQuery` returns full arrays — derive row-diffs by id map (keep the memoized mapper per row identity to kill the mapper-allocation churn S8 measured).
4. Do NOT attempt the server half (R8) or hoisting screen-local reads.

**Owned:** `packages/core/src/status/status-index.ts` (post-R2), `core/test/{status-index,load.perf}.test.ts`, `packages/ui/src/powersync/data-provider.tsx`, `apps/web/test/data-provider.test.ts`. **Forbidden:** `hooks.ts` (R3/R9), everything else in `ui/powersync` (R5/R6).
**DoD:** core coverage ≥90 (index file grew — cover the new paths); ui + web tests green incl. the new spy + equivalence tests; full gate green; log records measured before/after per-change cost at 100k (reuse the perf fixture).

---

## Session R8 — Server write-path scale + command-log effects channel

**Wave 3 (after R2, R4, R6 merged — last dispatcher surgeon) · Log:** `session-r8.md` · **Read first:** audit S4 report F2/F3/F7 (+S2-F3 server half, S3 handoff #2); §0.7 **D3**; spec §7.2f, §12 (jobs never blocked by long txns).

**Objective:** the server write path loses its 100k cliff (S4-F2) and `command_log` becomes the explainability channel §7.2f promised (S4-F3, per D3).

**Steps:**
1. Batch context (S4-F2): introduce a per-upload-batch memoized context (tree index / edge index / FactContext keyed by userId) with table-level invalidation — a handler that writes `nodes` invalidates the tree, etc. Commands in a batch already apply sequentially, so this is a simple dirty-flag cache, not concurrency work. Parallelize `loadFactContext`’s 9 sequential SELECTs with `Promise.all`. Replace full-tree loads for single-node invariants with targeted queries (parent row + child type counts) where the invariant allows.
2. Perf gate: new `apps/server/test/perf.write-path.integration.test.ts` (gated on `PRISMS_DB_TEST_URL` like the others): seed 100k nodes (reuse/port the core perf fixture generators), run a 20-command mixed batch (creates, check-offs with predecessors, clock-ins), assert a budget — record the pre-fix baseline first, then set the budget to lock in ≥5× improvement (state both numbers in the log; hard-assert the post-fix budget, soft-log the rest — mirror `load.perf.test.ts` house style).
3. Effects channel (S4-F3 / D3): handlers accumulate compact `{table, row_id, op, fields:[names]}` summaries (the core `OverlayEffect` shape) into a per-command collector written to `command_log.effects` in the same txn; automation spawns stamp `triggering_command_id` (the user command) on their summary entries + the log rows that carry them. Don’t build any UI — the WhyButton/history UI reads it later. Integration test: a check-off with automation writes a log row whose `effects` names the completion field + spawned rows, `triggering_command_id` set.
4. Stretch (skip cleanly if the session runs long — say so in the log): per-(user,device) last-applied-HLC floor with typed rejection (S4-F7); Annex-A2 far-future skew hard-reject + `clock_skew` review item.

**Owned:** `apps/server/src/dispatcher.ts` (wide — you are last; rebase on merged R2/R4/R6 first), new server perf test, dispatcher integration tests (append). **Forbidden:** jobs (R4 landed), core, ui.
**DoD:** full server integration + convergence green; perf test green with recorded numbers; core coverage untouched; no change to any response-contract shape (the harness proves it).

---

## Session R9 — Account boundary + mobile viability

**Wave 1 · Log:** `session-r9.md` · **Read first:** audit S9 report F1/F2/F3/F5 (+S8-F2, S8-F3), S1-F6 root cause; §0.7 **D6**; spec §13.2, R13, V12.

**Objective:** logout actually ends the account’s local presence (fixes High S9-F1), mobile export works (fixes High S9-F2), the React pairing becomes supported (S9-F3), crypto parameters match the cited standard (S8-F3), and the desktop shell gets its baseline hardening (S9-F5).

**Steps:**
1. Logout boundary (S9-F1 + S8-F2): on sign-out in **web and mobile**: if pending `client_commands` exist, warn (“N unsynced changes will be lost — sync first?”) with explicit confirm; then `await db.disconnectAndClear()`, clear `ROWS_CACHE`/`PRODUCED` (add a `clearReadCaches()` export in `hooks.ts` next to `__resetReadCacheForTests` — your ONLY hooks region), drop cached user state. Sturdier default: per-account `dbFilename` (`prisms-${userId}.db`/`.sqlite`) chosen at connect time — implement it; it also makes multi-account switching instant-safe. Test (web, jsdom/RTL): simulated A→B switch renders no A rows and uploads no A commands.
2. Mobile crypto (S9-F2): add `react-native-quick-crypto` (native `subtle` + fast PBKDF2), wire `globalThis.crypto` in mobile bootstrap before any portability call. Unit-verifiable half: a jest/vitest-level test asserting the polyfill registration path; real proof is step 5.
3. React pairing (S9-F3): `packages/ui/package.json` — move `react` to `peerDependencies`; delete the workspace-wide `react: '19.2.7'` override in `pnpm-workspace.yaml`; let mobile resolve Expo 53’s React 19.0.x and web its own. `pnpm install` + full typecheck across all seven manifests; `pnpm why react --filter @prisms/mobile` must show 19.0.x, web 19.2.x — paste both in the log.
4. Crypto parameters (S8-F3): `packages/ui/src/portability/crypto.ts` — PBKDF2 iterations 210k → **600k** for new exports (envelope already self-describing → old files keep decrypting; zero migration); cap accepted `iterations` on decrypt (≤10 M, typed error above); fix the OWASP comment. Update the ui portability tests’ expected params.
5. Device proof (D6): run `npx expo-doctor`; produce a dev build / emulator run; execute `apps/mobile/.maestro/worklist-offline.flow.yaml` and a manual export (passphrase → share sheet shows an encrypted blob). If no emulator is available in your environment, do everything static (doctor, dep graph) and mark the runtime step **BLOCKED — needs device**, with exact commands, in the log; do not claim it ran.
6. Desktop hardening (S9-F5): `apps/desktop/src-tauri/tauri.conf.json` — set a real CSP (local assets + API/PowerSync origins), register the notification plugin properly (or record that it needs the first desktop runtime pass), consider `withGlobalTauri: false`.

**Owned:** `apps/web/src/{App.tsx,auth.ts,powersync.ts}`, `apps/mobile/**`, `apps/desktop/**`, `packages/ui/package.json`, `pnpm-workspace.yaml`, `packages/ui/src/portability/crypto.ts` + tests, `packages/ui/src/adapters/*` if the storage seam needs a method. **Shared:** `hooks.ts` (cache-clear region only). **Forbidden:** `ui/powersync/*` (R5/R6/R7), root configs (R1).
**DoD:** full gate green on the new dependency graph (this is the risky one — typecheck all apps); web logout test green; log contains the `pnpm why` outputs, doctor output, and the honest device-run status; SECURITY_REVIEW text handed to R10 (don’t edit docs yourself).

---

## Session R10 — Sync topology, hardening, docs truth-up, release sign-off (integration finalizer)

**Wave 4 (after all others merged) · Log:** `session-r10.md` · **Read first:** audit S6 report F1/F2/F4, S10 report (all findings + gate map), S4-F4/F5/F6, S2-F2, S3-F7; §0.7 D4/D6/D7; FINAL_REPORT §5 test-gap appendix.

**Objective:** make the sync topology substantial (S6-F1/F2/F4), close the server hardening batch (S4-F4/F5/F6 + S10-F5, S3-F7), add the missing mechanical gates (S2-F2, S10-F1/F3a), then — as integrator — re-verify everything, truth-up the docs the audit flagged (S10-F1/F2), and sign off.

**Steps:**
1. Tier substance (S6-F1): `packages/db/sync-streams.yaml` — Tier 0 shrinks to the §7.3 bootstrap list (settings, active visions, near-agenda, open review items); move closed-old time entries, completed/archived subtrees, old diagram layouts into `history` via sync-rule date/status expressions (no client parameters — keep `auth.user_id()` scoping absolutely intact); `check-sync-rules` + `db/test/sync-streams.test.ts` updated. Client reads already tolerate absent Tier 2 rows (S6 verified) — spot-check the screens that surface history.
2. Drop `command_results` (S6-F2): remove the stream (S7 confirmed zero client readers; the response contract closes the loop). If D3’s populated `effects` motivates a future history UI, that’s a later feature — note it.
3. Publication scoping (S6-F4): replace `FOR ALL TABLES` with the explicit synced-table list (must ⊇ every table the streams reference — verify against current PowerSync docs online; if unverifiable, implement + flag for a staging soak). New init SQL + a migration-safe path for existing deployments (documented in SELF_HOSTING upgrade notes).
4. Server hardening: `env.ts` — fail fast in production on dev-default secrets (escape hatch `PRISMS_ALLOW_DEV_SECRETS=1`) + boot-time `base64url(POWERSYNC_JWT_SECRET) === PS_JWT_K_B64URL` check when the latter is present (S4-F4 + S10-F5); explicit Better-Auth `rateLimit` config + reuse `RateLimiter` for `/sync/import`, `/sync/export`, `/api/powersync/token` (S4-F5); hono `bodyLimit` — 2 MB `/sync/upload`, 32 MB `/sync/import` (S4-F6); predicate `matches` pattern-length cap (≤200) + validation at `rule.create`/`blocker.create` in `rules/validate.ts` — rebase on R2’s edit there (S3-F7).
5. Mechanical gates: db test deriving per-table shapes vs a committed per-`ROW_SCHEMA_VERSION` baseline JSON, asserted via core `isAdditiveSchemaChange` (S2-F2/S6-F5 — bumping the baseline file becomes the explicit major-version act); **two-user sync-down bucket-isolation test** (stack env boots PowerSync — subscribe two users’ tokens, assert bucket disjointness; S10-F1/F3a); 100k cold-start measurement against the compose stack (seed via R8’s fixture; record MBs + wall-clock in the log — measure, only optimize if egregious); optional CI: prod-compose `docker compose -f docker-compose.prod.yml build` job.
6. Docs truth-up (now that the fixes exist): SECURITY_REVIEW — isolation claim now cites the real test, mobile export row updated per R9’s outcome, logout boundary added to §7 with the R9 remediation, rate/body limits rows added (S10-F1); README + SELF_HOSTING — StatusIndex claims now true (R7/R8) so keep but recheck wording, D4 history-window note, D7 client-update-before-server upgrade note, TLS-termination paragraph (R1’s nginx work), Node-26 dev note if absent (S1-F9 doc half).
7. **Integration sign-off:** on the final merged `remediation` head run, in order: `pnpm turbo lint typecheck test` → `pnpm --filter @prisms/db test` + `pnpm --filter @prisms/server test` (live PG) → `pnpm test:convergence` → `pnpm --filter @prisms/core test:coverage` → `pnpm --filter @prisms/web build` → (stack up) `pnpm --filter @prisms/web e2e`. All green → update `docs/audit/AUDIT_PLAN.md` (append a “Remediation” status block: sessions, commits, gate evidence) and the matrix rows the fixes flip (R4/R19/V7/V10/V12, DoF 7/8/12/14/15/16/21/22 → re-verdict with commit refs; D6 outcome for DoF 23). Merge `remediation` → `m0-spike`; push only if the operator says so.

**Owned:** `packages/db/**`, `infra/**`, `apps/server/src/{env,app,rate-limit}.ts`, `.github/workflows/ci.yml` (additions), `docs/**`, `README.md`, `docs/audit/AUDIT_PLAN.md` + matrix (integrator privilege), new tests named above. **Shared:** `rules/validate.ts` (after R2). **Forbidden:** nothing new in `ui/powersync` or `dispatcher.ts` beyond rebasing.
**DoD:** the full §15-equivalent suite green on the merged head; every matrix row it re-verdicts cites a commit; sign-off block written in `session-r10.md`.

---

## Dispatch cheat-sheet

| Run | Prompt to give an LLM |
|-----|----------------------|
| Session RN | “Read `Blueprints/REMEDIATION_PLAYBOOK.md` §0 in full, then execute Session RN exactly as specified. Cut branch `r0N-<slug>` from `remediation`. Respect OWNED/SHARED/FORBIDDEN file fences and the wave/rebase order. Write `docs/audit/remediation/session-rN.md` and commit with `fix(rN): …`.” |
| Integrator (any wave boundary) | “Read `Blueprints/REMEDIATION_PLAYBOOK.md` §0.5–0.6. Merge the completed wave-N branches into `remediation` in session order, re-running `pnpm turbo lint typecheck test` + `pnpm --filter @prisms/server test` (live PG) after each merge. Resolve conflicts only inside declared hotspots, keeping both intents.” |
| Final | Session R10 (it is the integration finalizer). |

**Status tracker** (updated ONLY by the integrator/R10; sessions never edit this file):

| Session | Wave | Depends on | Status |
|---|---|---|---|
| R1 hygiene+spec | 1 | — | ⬜ |
| R2 status semantics | 1 | — | ⬜ |
| R3 hours correctness | 1 | — | ⬜ |
| R4 jobs lifecycle | 1 | — | ⬜ |
| R9 account+mobile | 1 | — | ⬜ |
| R5 write-path parity | 2 | R2 (hard), R4 (soft) | ⬜ |
| R6 upload+versions | 2 | R2 merged (harness Device) | ⬜ |
| R7 StatusIndex client | 2 | R2 (status-index.ts order) | ⬜ |
| R8 server scale+effects | 3 | R2, R4, R6 | ⬜ |
| R10 topology+docs+sign-off | 4 | all | ⬜ |
