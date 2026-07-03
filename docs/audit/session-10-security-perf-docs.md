# Audit Session 10 — Security, Performance, Docs, Release Infrastructure

Audited at commit `1498077` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — every commit since is docs-only under `docs/audit/` + the playbook), 2026-07-02.

**Scope examined:** `docs/SECURITY_REVIEW.md` (full, claim-by-claim), `docs/SELF_HOSTING.md`, `README.md`, `docker-compose.prod.yml`, `docker-compose.yml` (dev, for docs parity), `.env.example`, `infra/nginx/web.conf`, `scripts/{backup,restore}.sh`, `.github/workflows/` (full inventory — `ci.yml` is the only workflow), `apps/server/Dockerfile`, `apps/web/Dockerfile`, `apps/web/vite.config.ts` (PWA config — closes S9's declared gap), `packages/db/src/cli/check-sync-rules.ts`, `apps/server/test/convergence.integration.test.ts` (all 13 scenario bodies for the handoff assertions), `apps/server/test/api.integration.test.ts` (test inventory), `packages/core/vitest.config.ts` (perf-test inclusion), root `package.json`, `apps/mobile/.maestro/`, `apps/desktop/e2e/`, `Blueprints/other/ARCHITECTURE_1.3.md` §13/§15/§16, `Blueprints/other/ARCHITECTURE_1.3_ANNEX_A_RECOMMENDATIONS.md` (full). Fresh dynamic evidence gathered this session: `pnpm turbo lint typecheck test` 21/21; `@prisms/server` **114/114 integration tests green against live Postgres** (all 13 suites, incl. the convergence harness); `@prisms/core` coverage 537/537 tests, **90.58% statements / 93.8% functions / 93.65% lines** (≥90 floor met).

**Verdict:** release infrastructure is genuinely solid — prod compose fail-louds on every secret and correctly bridges the `PS_JWT_*` naming (closing S4-F4's worst case), backup/restore scripts are correct against the prod stack, CI runs real integration + e2e jobs, and the §15 perf gate runs on every PR. The security review is *mostly* accurate and unusually honest about residual risk, but overstates two controls (sync-down isolation "asserted" by tests that don't exist at that layer; mobile encrypted export marked ✅ when its only path statically cannot run) and omits the audit's biggest client-side hole (S9-F1 logout). The docs' headline performance claim (incremental StatusIndex) describes the test rig, not the shipped runtime. The convergence harness covers every §15-named scenario nominally, but two assertions the spec cares about (union-not-sum as an *aggregate outcome*, weather-divergent *acceptance*) test the primitive instead of the product, which is exactly where S3-F1/S3-F2 hide.

---

## Findings

### S10-F1 · Medium — `SECURITY_REVIEW.md` overstates two controls and omits the logout boundary

**Evidence:**
1. *Sync-down isolation:* `docs/SECURITY_REVIEW.md:36-37` — "Cross-user isolation is asserted in the convergence harness and the server integration suite (one user cannot receive another's rows)." No test asserts sync-**down** bucket isolation: the convergence harness's `Device` dispatches commands and reads Postgres directly (no PowerSync subscription anywhere in `convergence.integration.test.ts`), and every cross-user test in the server suite is command-path *ownership* (`dispatcher.integration.test.ts:432,471,574`, `m0-spike:155`, `m5-causal:190`, `m5-suggestion:156`). The only PowerSync-level test is JWT *verification* (`api.integration.test.ts:142`). Stream scoping is in fact verified — but statically, by S6's audit of `sync-streams.yaml` (every query filters `auth.user_id()`, zero client parameters), not by any test the doc can point to.
2. *Mobile encrypted export:* checklist row `SECURITY_REVIEW.md:127` — "Encrypted export ✅ AES-256-GCM; default on installed targets" — while the only mobile export path statically cannot run (S9-F2: `apps/mobile/src/portability.ts` → `encryptExport` → `crypto.subtle`, absent on Hermes, no polyfill dependency). The §7 runtime-unverified caveat (`:113-116`) hedges generally but the checklist asserts ✅ specifically.
3. *Omission:* the "documented limitations" section (`:94-116`) does not mention the shared-device logout boundary — no `disconnectAndClear`, account-agnostic db filename, pending commands uploading under the next account's session (S9-F1, High), plus the `ROWS_CACHE` carry-over (S8-F2). The doc predates those findings; as the §13 review of record it now understates residual risk.

**Failure mode:** an operator reads the security review, believes sync-down isolation is regression-tested and mobile export is functional, and hands a shared device across accounts believing local state is bounded by auth. All three beliefs are wrong today.

**Suggested change:** (a) add a two-user bucket-isolation test — CI's `stack` job already boots PowerSync; subscribe two tokens, assert bucket disjointness — or reword the claim to "verified by static stream-rule audit (S6); dynamic test pending"; (b) flip the export row to "✅ web/desktop · ❌ mobile pending S9-F2"; (c) add the logout/account-switch boundary to §7 with a pointer to the S9-F1 remediation.

### S10-F2 · Medium — README and SELF_HOSTING assert the incremental StatusIndex as shipped runtime behavior; no runtime path uses it

**Evidence:** `README.md:39-41` — "**Incremental `StatusIndex` (§7.12).** Per-command status recompute touches only the affected node + its dependency neighbours — O(neighbourhood), not O(table) (measured: 1 node / ~0.02ms on a 100k-node account)." `docs/SELF_HOSTING.md:97-100` repeats it ("the v1.4 **per-command** path… not a full table scan"). Established across three sessions: the index is a tested primitive with zero production consumers (S2-F3); the client rebuilds the full FactContext on every data change at the seam designated for the index (S8-F1); the server loads full per-user contexts inside command transactions (S4-F2). The measured 0.02 ms is real — in `packages/core/test/load.perf.test.ts`, which is the only caller.

**Failure mode:** the product documentation claims its headline scaling property from a primitive the product doesn't run. A 100k-node self-hoster gets O(table) rebuilds per interaction client-side and O(table) loads per command server-side, then files a bug the docs say can't exist.

**Suggested change:** wire the index (the audit's #1 consolidated workstream — S2-F3 + S2-F4 + S4-F2 + S8-F1) — or, until then, reword both docs: "the incremental index and its 100k gate exist in core; runtime wiring is pending (client provider + server dispatcher currently rebuild per change)."

### S10-F3 · Medium — §15 gates whose enforcing test checks the primitive, not the product (gate-mapping gaps)

**Evidence (from the full gate map below):**
- **(a) Sync-Streams isolation** — §15: "Sync Streams test proves one user cannot receive another user's rows." No dynamic test at any layer (F1.1). Static-only.
- **(b) Union-not-sum** — §15 names "double clock-in resolution" in the harness; scenario 9 (`convergence.integration.test.ts:595-625`) creates the overlapping closed entries, then asserts `mergeTimeEntries(rows).rawMinutes === 90` — **calling the resolver directly on rows it fetched itself** (`:613-621`). No production aggregate is asserted; the production paths (`aggregates/practice.ts`, `progress.ts`, `hooks.ts:726`, `aggregates-recompute.ts`) sum per-entry and would answer **120** (S3-F2/S5-F4). The gate passes while the product double-counts.
- **(c) External-fact divergence** — scenario 13 (`:710-744`) proves fact-row convergence and that a `node.rename` (a verb that never consults blockers) converges under divergent weather. It never exercises the one acceptance path that *does* consume weather — non-force `timer.clock_in` under a weather blocker rule (`dispatcher.ts:697-700`) — so the S3-F1 V10 violation sits exactly in the harness's blind spot.
- **(d) Envelope-version enforcement** — scenario 11 always *sends* `schema_version`; no test covers the absent-field bypass (S4-F1) nor the fact that real clients never send versions at all (S7-F3 — the harness `Device` models the spec's client, not the shipped one).
- **(e) Queue-cap regression** — nothing tests >100 pending commands end-to-end (S7-F2's wedge; handoff honored here: it belongs in the gate list).

**Failure mode:** all-green gates while three High findings (S3-F1, S3-F2, S7-F2) sit precisely in the untested seams — the pattern this audit found repeatedly (correct primitive, unwired/unasserted product path).

**Suggested change:** four additions — (a) the two-user bucket test (F1); (b) extend scenario 9 to assert `canonicalPractice`/progress output (fails today → pins the S3-F2 fix); (c) add a scenario-13b: weather-blocker rule + divergent facts + non-force clock-in, assert **applied** (fails today → pins the S3-F1 fix); (d) a 150-pending-commands regression through `uploadClientCommands` (fails today → pins the S7-F2 fix); plus an absent-`schema_version` envelope case once the S7-F3→S4-F1 coupled fix lands.

### S10-F4 · Low — prod nginx: no security headers, no cache policy for the PWA bundle, TLS posture undocumented

**Evidence:** `infra/nginx/web.conf` — zero `add_header` directives (no HSTS, no CSP, no `X-Content-Type-Options`, no `Referrer-Policy`); no cache-control block for `/assets/*` (Vite's content-hashed files re-validate on every load; `index.html`/`sw.js` rely on nginx defaults + the autoUpdate SW); the server listens on `:80` with TLS implicitly delegated to an upstream proxy that neither compose nor SELF_HOSTING mentions (the real deployment fronts it with Tailscale HTTPS — undocumented as a requirement).

**Failure mode:** a self-hoster exposes `:8088` directly: no HSTS/CSP on an auth-cookie-bearing origin; hashed assets re-fetched needlessly (the PWA precache mitigates repeat visits, not first loads).

**Suggested change:** add to `web.conf`: `Strict-Transport-Security` (behind a documented TLS terminator), a CSP compatible with the SPA + `/powersync` WebSocket + wasm (`wasm-unsafe-eval` for wa-sqlite), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`; `location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }` and explicit `no-cache` for `index.html` + `sw.js`; one SELF_HOSTING paragraph: "terminate TLS in front (reverse proxy/Tailscale); the container serves plain HTTP."

### S10-F5 · Low — the `PS_JWT_K_B64URL` ↔ `PS_JWT_SECRET` invariant is manual and unchecked at boot

**Evidence:** `docker-compose.prod.yml:42` requires `PS_JWT_K_B64URL` ("base64url of PS_JWT_SECRET"), `:69` passes the raw secret to the API; `.env.example:26-31` documents the derivation command. Nothing verifies they match: a mismatch (typo, forgotten `=`-padding strip, rotating one but not the other) boots every service healthy — and every PowerSync token the API signs fails validation, so the app renders but never syncs, with no error pointing at the cause.

**Suggested change:** at API startup, when `PS_JWT_K_B64URL` is present in the environment, compute `base64url(POWERSYNC_JWT_SECRET)` and fail fast on mismatch (three lines in `env.ts`, where the S4-F4 prod fail-fast also belongs); or drop the second variable entirely by templating the PowerSync config from the raw secret in an entrypoint.

### S10-F6 · Low — server Docker image: single-stage, whole-repo copy, no layer caching

**Evidence:** `apps/server/Dockerfile` — `COPY . .` *then* `pnpm install --frozen-lockfile --filter "@prisms/server..."`; single stage; the final image carries the entire repo (apps/web, Blueprints, docs) plus the full pnpm store for the subtree, and any file change invalidates the install layer. Contrast `apps/web/Dockerfile`, which is properly multi-staged (build → `nginx:1.27-alpine`, only `dist` copied).

**Suggested change:** lockfile-first copy (`pnpm-lock.yaml` + workspace manifests → `pnpm fetch`), then source copy + offline install; add a runtime stage (`pnpm --filter @prisms/server deploy` or prune) so the image ships `core`+`db`+`server` only. Build-time and image-size win; no behavior change.

### S10-F7 · Low — PWA manifest has no icons: the app is not installable (closes S9's PWA coverage gap)

**Evidence:** `apps/web/vite.config.ts:33` — `icons: []`. Chromium's install criteria require at least 192px + 512px icons, so "Add to Home Screen"/desktop install never offers. The rest of the PWA config is *correct*: precache of `js/css/html/wasm` with an 8 MB cap for the sqlite wasm (`:20-21`), `navigateFallback` with `/api` + `/sync` denylisted (`:24-25`), **no runtimeCaching** — API responses are never cached by the SW (the playbook's mis-caching concern is clean), and the SW is enabled in dev so the airplane-mode e2e exercises the real shell (`:18`).

**Suggested change:** add 192/512 (+maskable) icons to the manifest. Hygiene: add `/powersync` to the denylist (inert today — WS/fetch bypass `navigateFallback` — but cheap future-proofing).

### S10-F8 · Info — DoF 23 adjudication: web passes; mobile/desktop rest on a documented-but-unaccepted exception, and the mobile flow would fail today

**Evidence:** web has the real thing — 10 Playwright specs run in CI against a live stack (`ci.yml` e2e job; spec inventory verified S9). Mobile and desktop each have exactly one smoke-flow *artifact* (`apps/mobile/.maestro/worklist-offline.flow.yaml`, `apps/desktop/e2e/worklist-offline.e2e.ts`); `.github/workflows/` contains only `ci.yml`, so "wired for dedicated runners" (`ci.yml:137-140`, `SELF_HOSTING.md:104-111`) means "flows exist, no runner runs them." DoF 23 accepts "a documented, accepted v1 exception" — the documentation half exists (SELF_HOSTING is explicit and honest); the *acceptance* is the product owner's call, and it should be made knowing S9-F2 (mobile export throws) and S9-F3 (unsupported React pairing) statically predict the mobile flow **fails** if ever run.

**Suggested change:** record an explicit decision in the tracker: either accept the exception for v1 (and fix S9-F2/F3 before the first real device run), or stand up one emulator runner for the Maestro flow as the release gate.

### S10-F9 · Info — small docs/infra accuracies (bundle)

- `docker-compose.yml:8` still says "TODO(s23): build apps/server into this service" — S23 shipped that as `docker-compose.prod.yml` instead; the dev stub is intentional and README documents it correctly (`README.md:78`). Update the stale comment.
- README dev quickstart says `docker compose up -d postgres` under Development but the WSL section says `wsl docker compose up -d` (all three services incl. the stub api) — both work; unify on one.
- `restore.sh` doesn't stop the `api` service during `pg_restore --clean`; a command applying mid-restore can hit dropped tables. One-line doc note ("stop api first for a quiet restore") or `$COMPOSE stop api` in the script.
- Backup covers the `prisms` DB only — correct by design (PowerSync storage is derived; the script header says so) — noting it here as verified-intentional.
- SELF_HOSTING's Verification-status section is a model of honesty (config-validated vs runtime-verified split stated plainly) — the F2 StatusIndex sentence is its one overstatement.

---

## Resolved handoffs (routed to S10 from S1–S9)

| Handoff | Resolution |
|---|---|
| Prod compose maps `PS_JWT_*` → API `POWERSYNC_JWT_*` (S4-F4) | **PASS** — `docker-compose.prod.yml:67-71` maps all three with `:?` fail-loud guards; `.env.example` documents the derivation. S4-F4's dev-fallback residual now only reachable outside compose; the fail-fast suggestion stands as defense-in-depth (fold with F5). |
| Dev-secret fail-fast + body limits + auth rate limiting in threat pass (S4) | **CARRIED into the roll-up** — S4-F4/F5/F6 confirmed still open; no new exposure found beyond them. Threat-pass additions this session: F4 (headers), F5 (jwks invariant). |
| Harness: weather-divergence must assert non-force clock-in acceptance (S3-F1) | **CONFIRMED ABSENT → F3c.** |
| Harness: union-not-sum must assert an aggregate value (S3-F2) | **CONFIRMED ABSENT → F3b** (scenario 9 asserts the resolver's own output). |
| Harness: accept-optimize-suggestion double-book scenario (S5-F2) | **ABSENT** — no scenario accepts a suggestion for an already-scheduled task; add alongside F3's additions. |
| 150-pending upload regression in the gate list (S7-F2) | **RECORDED → F3e.** |
| Remediation must sequence S7-F3 (client sends versions) before S4-F1 (server rejects absent) | **RECORDED** in the remediation plan (Synthesis). |
| `PS_JWT_K_B64URL` ↔ secret invariant (S6) | **CONFIRMED unchecked → F5.** |
| `sync-rules:check`/db sync-streams test required in CI (S6) | **PASS** — `db/test/sync-streams.test.ts` runs in the `stack` job (`ci.yml:49-52`); the CLI uses the service's own parser (`@powersync/service-sync-rules`). |
| Publication scope vs PowerSync docs (S6-F4) | **PARTIAL** — requirement direction confirmed (published set must ⊇ sync-rules tables, so narrowing to the 22 synced tables is safe in principle); exact doc citation needs an online check. S6-F4's change stands. |
| 100k cold-start sync measurement (S6-F1) | **NOT MEASURABLE STATICALLY** — recorded as a performance-claims gap (below). Requires a seeded 100k account against the compose stack. |
| SECURITY_REVIEW claims about logout/local-data clearing (S9-F1) | **Doc is silent** on logout → folded into F1.3. |
| DoF 23 statement (S9) | **→ F8.** |
| PWA config unexamined (S9) | **CLOSED → F7** (config sound; icons missing). |
| Agenda budget "verified by observation not assertion" (S2-F7) | **RECORDED** in the performance-claims register below. |

## Compliance checklist results

**§15 gate map (gate → enforcing test → status):**

| §15 gate | Enforcing test(s) | Status |
|---|---|---|
| Core line coverage ≥ 90% | `packages/core/vitest.config.ts` thresholds (90/90/90) + CI `checks` step; measured 90.58/93.8/93.65 this session | **PASS** |
| Every invariant has a rejecting test | `catalog.test.ts:96-192` (I1–I10, per number) | **PASS** (client never *runs* them at runtime — S3-F3/S7-F4) |
| Scheduler property tests: overlap, anchoring, dependencies, idempotency | `scheduler/{greedy,optimize,placement}.property.test.ts` | **PASS** |
| Rules property tests: idempotency, deterministic IDs, drift | `rules/determinism.property.test.ts` + drift-content tests | **PASS** (V6 attribution half — S3-F4) |
| Two-device convergence: offline edits, HLC conflict, automation spawning, double clock-in, sort_order, mixed schema, external-fact divergence | `convergence.integration.test.ts` scenarios 1–13 — every named scenario present; 114/114 green vs live PG this session | **PASS nominally; F3b/F3c assert the primitive, not the product** |
| Command-bridge: named commands only; overlay never uploads as row patches | connector loud-guard test, `effects.test.ts` coverage sweep, `api.integration:313`, DoD e2e | **PASS** |
| Overlay reconciliation: identical canonical row + matching `created_by_command_id`; rejected overlay vanishes | scenarios 7, 8 | **PASS** (client drops on ack, not canonical arrival — S7-F6) |
| Causal ordering: `dependency_rejected` + linked review item | scenario 12 + `m5-causal` suite | **PASS** (real clients never send `depends_on` — S7-F5) |
| Sync Streams: one user cannot receive another's rows; params can't widen | **none** (static audit S6 only) | **GAP → F1/F3a** |
| Command version migration + `client_too_old` | scenario 11 + dispatcher tests (floor); no migrator exists (single version era) | **PASS on floor; absent-field bypass untested → F3d** |
| Trust-field ignore/overwrite | dispatcher + m0-spike suites | **PASS** |
| Provenance explanation (tasks, suggestions, automation, aggregates) | ui `provenance.test.ts` + integration provenance assertions | **PASS** (version line blank — S3-F4/S8-F5) |
| Review inbox durability (rejections, dependency, drift, conflicts) | scenarios 8/11/12, review-command tests | **PASS** (expiry lifecycle unwired — S5-F1) |
| Export/import round-trip; no replay; HLC monotonic | `m13-portability.integration.test.ts` (6) + e2e `m13.spec.ts` | **PASS** |
| Perf: per-command status recompute + agenda at 100k | `load.perf.test.ts` — per-command < 16 ms **hard** (≈0.01–0.02 ms measured); agenda soft-gated (< 10 s assert, ~65 ms logged — S2-F7); runs in default suite → in CI `checks` on every PR | **PASS as written; server write path unmeasured (S4-F2); wiring caveat F2** |
| Adapter-boundary lint (core imports no provider SDKs) | eslint purity/boundary blocks + `architecture-lint.test.ts` | **PASS** |
| §15 command equivalents (`test:integration`, `test:e2e`, `test:perf`, …) | root `package.json` has `lint/typecheck/test/test:convergence/ci` only | **PARTIAL** (S1-F4 stands; capabilities exist behind filters) |
| `docker compose up --build` | prod compose config-validated (M15) + dev compose exercised in CI; prod images **never built in CI** | **PARTIAL** — add a prod-compose build job or accept documented |

**SECURITY_REVIEW claim-by-claim:** §1 (trusted write path) **verified** (S4+S7+M15 coverage test; loud guard). §2 stream scoping **verified statically** / "asserted by tests" **overstated → F1.1**; JWT flow verified (`api.integration:122,142`). §3 trust-strip + import guard **verified** (S4, S5; `m13` test exists as cited). §4 causal/review **verified** (S4; noting S7-F5's client half). §5 secure storage/CSRF/rate-limit **verified as written** (S4-F5's gaps are things the doc doesn't claim). §6 export exclusions + crypto **verified**; mobile ✅ **overstated → F1.2**; 210k-iterations claim accurate as stated (the *code comment's* OWASP cite is the S8-F3 nit). §7 residual risks **honest**; missing logout boundary **→ F1.3**.

**Convergence harness vs §15 named list:** offline edits (1,2) · HLC conflict (3,6) · automation spawning (5) · double clock-in (4,9) · sort_order collision (10) · mixed schema versions (11) · external-fact divergence (13) · plus overlay reconcile (7), rollback (8), dependency cascade (12) — **all named scenarios present**; assertion-depth caveats in F3.

**Performance claims register:** per-command recompute ≤16 ms @100k — **asserted** (hard, CI) but describes an unwired primitive (F2). Agenda build ≤100 ms @100k — **observed** (~65 ms logged), soft-asserted only (S2-F7, rationale documented). Server write path @100k — **no test** (S4-F2). Cold-start sync @100k (V8's motivation) — **no measurement** (S6-F1). StatusIndex `apply` ~0.02 ms + touch-set <100 — **asserted**.

**CI coverage of §15:** unit+coverage+build (`checks`), db+server integration incl. convergence vs live compose PG+PowerSync (`stack`), 10-spec Playwright vs live stack with correct migrate-before-PowerSync ordering (`e2e`). Not in CI: prod-image build, mobile/desktop flows (F8), 100k cold-start. CI-minutes efficiency: acceptable (three jobs, pnpm cache; e2e rebuilds web rather than reusing `checks`' artifact — minor).

## Annex A prioritization (A1–A8 → post-v1.4 backlog)

- **A2 Clock-skew guard — adopt next.** Small (HLC already exposes physical ms; server middleware + client floor-merge on rejection), and it closes a real hole this audit found independently: S7-F8's restart clock-regression plus the far-future clamp the security review lists as residual risk. The harness case is already specified in the annex.
- **A4 Command-queue crash recovery — adopt next.** Half-built already: enqueue is atomic (S7 verified), re-upload is idempotent (R18). Adopting the lease/backoff/attempt-counter surface is the natural home for the S7-F2 fix (4xx vs network distinction, chunking) and S7-F9's watch-disposal — one coherent PR instead of three patches.
- **A3 Applied-overwritten reconciliation — adopt soon.** S7-F6's proper fix (reconcile on canonical arrival, not ack) builds 80% of A3's machinery; the `applied_overwritten` review item is the remaining 20% and directly serves R9's explainability promise.
- **A8 Sync/debug diagnostics — adopt soon.** Cheap (read-only screen over state that already exists) and high-leverage: pending-count/oldest-pending-age/stream-status would have made S7-F2's silent wedge user-visible. Gate the production build behind an advanced flag as specified.
- **A5 History compaction/redaction — adopt when deciding history retention.** It is the designed vehicle for S5-F7 (splitting the 90-day dedup horizon from user-facing history retention). Not urgent until history UX matters, but the decision should be made deliberately, not by the purge default.
- **A1 Device registry — defer.** Real value (revocation, S4-F7's per-device HLC floor, diagnostics attribution) but meaningful schema+auth surface, and single-user self-hosting blunts the threat it addresses. Ride on it when multi-device management becomes a product feature.
- **A6 Import modes — defer.** Today's `restore_same_user` + skip-on-collision is safe, tested, and honestly documented (SECURITY_REVIEW §7). Merge/new-user modes are migration *features*; adopt A6's dry-run reporting shape when they're wanted.
- **A7 Local-first search — defer.** Product feature with a real per-platform FTS adapter cost; no spec gate depends on it. The annex's merged-state requirement (overlay-aware search) is the part to honor when built.

## Positive observations

- `docker-compose.prod.yml` is the best-engineered config file in the repo: every secret `:?`-guarded, the `PS_JWT_*`→`POWERSYNC_JWT_*` bridge commented with its rationale, healthchecks on all services, and the web bundle's PowerSync URL baked to the single-origin `/powersync` proxy path.
- `.env.example` teaches the two real deploy traps (URL-safe `POSTGRES_PASSWORD`, base64url key derivation) with exact commands — this is what prevented-incident documentation looks like.
- `backup.sh`/`restore.sh` are small, correct, and match the docs: `-Fc` custom format, `--clean --if-exists --no-owner`, `exec -T`, and the PowerSync-restart guidance after restore.
- The e2e job's migrate-before-PowerSync ordering (with the replication rationale inline at `ci.yml:94-97`) encodes a failure mode most teams learn in production.
- `check-sync-rules.ts` validates with the *service's own parser* rather than a lookalike — the strongest possible static guarantee short of booting the service.
- The perf test lives in the default vitest include, so the §15 per-command budget is a real per-PR gate, not a special-occasion script.

## Proposed matrix updates (for Synthesis to apply)

- R3 → ✅ (13-scenario harness green vs live PG this session; assertion-depth caveats F3b/c noted)
- R10 → ✅ (server S5 + client S8 + scripts/docs verified this session)
- R11 → ⚠️ (export side ✅; command-envelope side vacuous end-to-end until S7-F3+S4-F1 land)
- V8 → keep ⚠️, add "cold-start measurement missing (S10)"
- DoF 23 → ⚠️ (web ✅; mobile/desktop exception documented, unaccepted, mobile statically failing — F8)
- §15 gates row → ⚠️ with the gate-map table above as evidence
- Annex A table → replace "➖ backlog" with the eight verdicts above

## Handoff items

None — this is the final session. Everything outstanding flows to the **Synthesis** (`FINAL_REPORT.md`): the consolidated findings register, the High spot-verification pass, the matrix/tracker updates, and the remediation sequencing (notably: S7-F3 before S4-F1; scenario additions F3b/c/d/e pinning the S3-F1/S3-F2/S7-F2 fixes).
