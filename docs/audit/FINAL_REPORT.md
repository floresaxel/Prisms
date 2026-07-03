# Prisms Codebase Audit — Final Report

Synthesis of audit sessions 1–10 (`docs/audit/session-01…10-*.md`). Code baseline: commit `2ab3bf7`, branch `m0-spike` (every later commit is audit-docs-only). Audited 2026-07-01 → 2026-07-02 against the intended feature set: `ARCHITECTURE_1.3.md` (R1–R20, V1–V12, §§4–13, §15 gates, DoF 1–23) + `CHANGE_SPEC_v1.0_to_v1.4.md` (incl. Fix A §7.14, Fix C §7.15). Every Critical/High claim below was re-traced through the code during synthesis (playbook step 5); dynamic evidence: 21/21 repo gate, **114/114 server integration tests vs live Postgres** (incl. all 13 convergence scenarios), core coverage 90.58%/93.8%/93.65% (≥90 floor).

---

## 1. Executive summary

**Overall verdict: the architecture is genuinely implemented — and the residual defects cluster in one repeating pattern.** The load-bearing v1.3/1.4 contracts are real in the code, not aspirational: the two-layer client store with a loud upload guard (R15/R6/DoF 1–3), write-time command identity end-to-end (V2), strip-then-validate trust boundary (V4/R17), the six-step §7.5 suggestion transaction with in-txn automation fixpoint behind a SAVEPOINT (§10.1), airtight per-user sync-stream scoping (S6), a data-only import with a cross-account global-id guard (R20), and a physical schema layer S6 called "excellent." Of 20 hard requirements: **12 verified clean, 8 verified with findings, 0 outright gaps.**

The audit's signature finding is **"correct primitive, unwired product path."** Five separately-built, well-tested mechanisms have zero production consumers: the incremental `StatusIndex` (V7), the `mergeTimeEntries` union resolver (§7.10b), client-side invariant checks (§8), the client rules engine (R4 offline spawning), and `review.expire_resolved`. Each passes its gate while the shipped path does something else. The single highest-value remediation theme is *wiring what exists*, not building new machinery.

**The six High findings (0 Critical):**

1. **S3-F1 — weather gates command acceptance (V10/R19 violation).** `dispatcher.ts:699` consults `isBlocked` — which evaluates weather-derived blocker rules — for non-force `timer.clock_in`. A user with any weather blocker rule gets spurious server rejections whenever device and server weather freshness diverge. The convergence harness's weather scenario tests a verb that never consults blockers, so the gate stays green (S10-F3c).
2. **S3-F2 — effective hours double-count overlapping entries (§9.2 violation).** `mergeTimeEntries` has zero production consumers (re-verified); practice/progress/dashboard/server-canonical aggregates all sum per-entry. Two devices that both clock in *and out* offline converge to the same **wrong** number. Scenario 9 asserts the resolver, not any aggregate (S10-F3b).
3. **S7-F1 — offline automation spawning does not exist (R4).** No client path runs `runAutomations` (re-verified: server dispatcher + backstop only). Offline, completing a task with a spawn rule produces nothing until reconnect — a hard-requirement hole, though convergence-safe.
4. **S7-F2 — >100 pending commands permanently wedge the upload queue.** One unchunked POST (`upload-commands.ts:50-65`) vs the server's 100-command envelope cap → 400 → generic throw → silent 15 s retry loop, forever. A busy offline weekend triggers it.
5. **S9-F1 — logout leaves the previous account's replica, cache, and pending queue live.** No `disconnectAndClear` anywhere (re-verified), account-agnostic `dbFilename` on web and mobile, SPA sign-out; user B on a shared device sees user A's data instantly and A's pending commands upload under B's JWT (becoming B's rows). Absorbs S8-F2 (`ROWS_CACHE` never cleared).
6. **S9-F2 — mobile export always throws.** The only path calls WebCrypto `subtle()`; Hermes has none and the only polyfill present is `getRandomValues` (re-verified in `apps/mobile/package.json`). V12's encrypted-by-default makes the feature 100% unavailable on mobile. Compounded by **S9-F3 (Medium-High)**: React 19.2.7 force-resolved under RN 0.79/Expo 53 — an unsupported pairing; mobile runtime has never been verified anywhere.

**Biggest efficiency wins** (details §5): wire the StatusIndex at its two designed seams — the client data-provider rebuilds the full `FactContext` on every keystroke-level command (~65 ms at 100k, S8-F1) and the server loads full per-user contexts inside command transactions (9 sequential full-table SELECTs per gated command, S4-F2) while a 0.02 ms incremental primitive sits tested and idle; make the sync-tier split real (Tier 0 currently ships the whole tree; the `command_results` stream syncs up to 90 days of payloads no client table can read — S6-F1/F2); stop hourly-recomputing every user's aggregates (S5-F6); and scope the `FOR ALL TABLES` publication that funnels auth/session/job-queue churn through PowerSync's replication slot (S6-F4).

**Docs/security-review accuracy:** mostly honest, three drifts — sync-down isolation claimed "asserted by tests" (it's verified statically only), mobile encrypted export marked ✅ (statically broken), and README/SELF_HOSTING present the incremental StatusIndex as shipped runtime behavior (S10-F1/F2).

---

## 2. Compliance scorecard

### Hard requirements (R1–R20): 12 ✅ · 8 ⚠️ · 0 ❌

| Status | Requirements |
|---|---|
| ✅ verified | R2 local-first reads · R3 offline+convergence (13-scenario harness green vs live PG) · R5 vanilla stores · R6 named-commands-only (end-to-end) · R7 server-optional · R8 LLM-friendly/strict/coverage · R10 portability · R12 durable review inbox · R14 adapters contain providers · R15 two-layer store · R17 trust fields server-assigned · R18 dedup ≥ horizon · R20 import-as-data + HLC floor |
| ⚠️ with findings | R1 (mobile/desktop runtime unverified; S9-F2/F3) · R4 (**offline spawning absent** S7-F1; delete-closure degraded S7-F7) · R9 (`command_log.effects`/links never written S4-F3) · R11/R16 (envelope versions never sent → floor vacuous; S7-F3+S4-F1) · R13 (logout boundary S9-F1) · R19 (weather gates clock-in S3-F1) |

### Mandatory revisions (V1–V12): 6 ✅ · 6 ⚠️

✅ V1 (rollback drops overlay; timing note S7-F6) · V2 (id end-to-end) · V3 (causal gate exact; cross-batch floor = hardening S4-F7) · V4 (strip-then-validate) · V5 (0008 verified additive; the *mechanical* gate is still missing S2-F2/S6-F5) · V11 (purge boundary correct).
⚠️ V6 (backstop decision table ✅; `template_version` read-but-never-written S3-F4) · V7 (**primitive unwired** S2-F3/F4) · V8 (stream security airtight; tier substance nominal S6-F1/F2) · V9 (implemented + property-tested; double clock-in survivor + UI tiebreak deviate from spec letter S2-F1/S8-F4) · V10 (S3-F1) · V12 (mobile path throws S9-F2).

### Definition of Finished (DoF 1–23): 12 ✅ · 11 ⚠️ · 0 ❌

✅ 1, 2, 3, 4, 5, 6, 9, 10, 11, 13, 17, 19, 20. (5 carries S7-F6's reconcile-timing note; 9 carries S10-F3's assertion-depth caveats; 11 carries S5-F4's value-correctness caveat.)
⚠️ 7 (clients never send `depends_on` — S7-F5) · 8 (offline spawning — S7-F1) · 12 (`replaces_block_id` never stamped → accept double-books — S5-F2) · 14 (SF completion lag + SS availability lag dropped — S3-F5) · 15 (envelope versions absent end-to-end — S7-F3/S4-F1) · 16 (status derived, no stored column ✅ — but not *through the index* on any live path — S2-F3) · 18 (drift surfaced ✅; version attribution missing — S3-F4/S5-F8) · 21 (web/desktop ✅; mobile export broken — S9-F2) · 22 (adapters ✅; external-fact gating — S3-F1) · 23 (web e2e ✅; mobile/desktop = documented-but-unaccepted exception, mobile statically failing — S10-F8).

### Accepted deviations (record in the spec)

- No `packages/adapters` workspace — ports live in `packages/ui/src/adapters/` (S1-F8); R14's substance verified.
- §7.13's `command_id REFERENCES command_log(id)` FK deliberately dropped (enables the 90-day purge; S5-F7/S6-F6).
- Export manifest omits §13.1's optional `app_version`/`checksums`/`attachments` (strict-schema simplification; S5-F9).
- Aggregates recompute hourly-all-users instead of nightly-per-user (documented; costs ~24× compute — S5-F6).
- Client schema omits `schema_version` (not needed client-side) and provenance columns beyond nodes/blocks (M9 scope; S6-F6).
- Harness locks in latest-wins double clock-in (vs §7.10b's earliest-wins letter) — **pending an explicit decision** (S2-F1, §6 below).

### Handoff resolution

All 30 cross-session handoffs were resolved in the receiving sessions' "Resolved handoffs" tables (S4: 7, S5: 6, S6: 8, S7: 6, S8: 4, S9: 6, S10: 13). Declared unresolved at close: **(a)** PowerSync publication-scope doc citation (S6-F4 — needs an online docs check; direction confirmed safe), **(b)** 100k cold-start sync measurement (S6-F1 — needs a seeded live stack; recorded as a performance-claims gap). One finding was **corrected during the audit**: S6-F3 (UI sibling order divergence) was downgraded by S8-F4 — order is deterministic and convergent via an `(sort_order, id)` tiebreak; only the spec-letter `hlc` tiebreak deviation remains.

---

## 3. Findings register

63 findings across 10 sessions → **48 distinct after merging** (root-cause merges noted). Sorted by severity, then remediation effort (S/M/L). Evidence and failure scenarios live in the per-session reports; each entry here is the adjudicated one-liner + the change.

### High (6)

| ID | Finding | Change | Effort |
|---|---|---|---|
| **S3-F1** (+S3-F8, S5-F10, S10-F3c) | Non-force `timer.clock_in` acceptance consumes weather-derived blocking (`dispatcher.ts:699`) — V10/R19 violation; weather predicates are also legal-but-inert in automation conditions | Core: `referencesExternalFacts(predicate)` + acceptance-safe `isBlocked` variant; use it at the single call site; forbid external-fact namespaces in automation conditions at `validateAutomationRule` (they can never fire — S5-F10); add harness scenario 13b asserting non-force clock-in **applies** under divergent weather | **S** |
| **S3-F2** (+S5-F4, S10-F3b) | Effective hours/progress/practice (client **and** server-canonical) sum overlapping entries per-entry; `mergeTimeEntries` unconsumed — silent convergent over-count | Consume the resolver: `canonicalPractice`/progress union per task (fixing core fixes both tiers); dashboard today-total unions per task/day; extend scenario 9 to assert an aggregate value (fails → pins the fix) | **S–M** |
| **S7-F2** | >100 pending commands → single POST vs 100-cap → permanent silent 400 retry loop | Chunk into sequential ≤100 batches (HLC order); distinguish 4xx (surface loudly) from network (retry); regression test at 150 pending | **S** |
| **S9-F1** (+S8-F2) | Logout: no `disconnectAndClear`, fixed `dbFilename`, module caches kept, pending commands upload under the next session — cross-account exposure both directions | On sign-out: warn if pending commands exist, then `disconnectAndClear()` + clear `ROWS_CACHE`/`PRODUCED`; sturdier: per-account `dbFilename` (`prisms-${userId}.db`); update SECURITY_REVIEW §7 | **S–M** |
| **S9-F2** | Mobile export calls `crypto.subtle` — absent on Hermes, no polyfill → V12 flow throws 100% | Add `react-native-quick-crypto` (native `subtle`, fast PBKDF2) wired to `globalThis.crypto`; verify on device | **S** (+device verify) |
| **S7-F1** | Offline automation spawning absent — no client `runAutomations` (R4 hard requirement) | In `execute()`, on task-created/completed verbs run core `runAutomations` against merged facts, append spawn effects; UUIDv5 ids make server reconciliation byte-identical (designed for this) | **M** (shares W4 plumbing) |

### Medium (19 after merges)

| ID | Finding | Change | Effort |
|---|---|---|---|
| **S9-F3** (Med-High; ex-S1-F6) | React 19.2.7 forced under RN 0.79/Expo 53 — unsupported pairing; root cause: `@prisms/ui` declares `react` in `dependencies` | Move to `peerDependencies`, drop the workspace override, let each app resolve its own React; `expo-doctor` + device build to confirm | S |
| **W1: S2-F3+S2-F4+S4-F2+S8-F1** | The StatusIndex is unwired at both designed seams: client provider rebuilds full FactContext per data change (~65 ms @100k per keystroke-level command); server runs full-context loads (9 sequential SELECTs) inside command txns; index fan-out gaps (phase/weather blockers → all-tasks dirty) would bite once wired | Fix fan-out scoping first (S2-F4), then wire `StatusIndex.apply()` + incremental TreeIndex into `data-provider.tsx`; server: per-batch memoized context + parallelized SELECTs short-term, incremental context long-term; add a server write-path perf test @100k | L |
| **W6: S7-F3+S4-F1** (+S3-F9, S10-F3d) | Envelopes never carry `command_version`/`schema_version` (core's `defaultCommandMeta` unconsumed), and the server skips the floor when absent — §7.11/R16 vacuous end-to-end | **Sequenced:** client persists+sends versions at enqueue first; then server treats absent as below-floor; add the absent-field envelope test | S (2 PRs, ordered) |
| **S7-F4** (=S3-F3) | No client invariant pre-flight against merged state (§7.2d step 2) — invalid commands sit "applied" all offline, then revert | Run the verb's checker against merged FactRows in `execute()` before enqueue (pure functions exist; shares W4's data dependency) | M |
| **S7-F5** | `depends_on` never derived/sent — V3's server semantics + review-item UX never fire for real clients; rejection cascades degrade to `E_NOT_FOUND` | Derive at enqueue from overlay insert row-ids matching payload references; store + send | S–M |
| **S7-F6** | Overlay dropped on ack, not canonical arrival (§7.2d) — visible revert-flicker window on slow links (propagates through ROWS_CACHE, S8-F6) | Applied-tombstone: keep effects until the canonical row with `last_modified_by_command_id == id` arrives (natural A3 stepping stone); or document the tradeoff | M |
| **S7-F7** | Offline soft-delete leaves descendants visible (no client I10 closure; `extraEffects` mechanism built, uncalled; stale comment claims otherwise) | Compute `softDeleteClosure` over the merged tree → `del` effects via `extraEffects`; fix the comment | S |
| **S5-F1** | `review.expire_resolved` never scheduled; `sync_review_items` (+ tags tables) missing from `PURGE_ORDER` — resolved items accumulate and sync forever | Add queue+weekly schedule in `boss.ts` (3 lines); add 4 tables to `PURGE_ORDER` | S |
| **S5-F2** | Optimize suggestions never set `replaces_block_id` → accepting a reschedule double-books (accept-txn's soft-delete branch dead) | Stamp the overlapped/earliest live flexible block id on suggested rows; add the accept-double-book harness scenario | S |
| **S5-F3** | Past-due notifications re-fire every 15 min per task, forever | Notify only on first suggestion creation (or per-task `last_notified_at` watermark) | S |
| **S5-F5** | Aggregates job's "consistent snapshot" runs at READ COMMITTED — torn cross-table reads possible | `db.transaction(fn, { isolationLevel: 'repeatable read' })` | S |
| **S4-F3** | `command_log.effects`/`parent_command_id`/`triggering_command_id` never written — §7.2f/R9's command-level channel empty (provenance panel's version line also blank — S3-F4/S8-F5) | Accumulate compact per-handler effect summaries in-txn; stamp automation links; or amend the spec and drop the columns — decide | M |
| **S3-F4** (+S5-F8) | `template_version` read by UI, never defined/stamped anywhere; drift items can't attribute template generations (V6 half) | `TEMPLATE_VERSION` const in `rules/actions.ts`; extend `SpawnProvenance`; stamp at both server write sites | S |
| **S3-F5** | SF completion lag and SS availability lag silently dropped (`FactContext.hasAnyEntry` is boolean — earliest start unavailable) | Add `earliestEntryStart` to FactContext + StatusIndex; enforce in both gates; two lag tests | S–M |
| **S4-F4** (+S10-F5) | Dev-secret fallback only warns (prod compose is `:?`-guarded, but out-of-compose runs boot with a public JWT key); `PS_JWT_K_B64URL`↔secret invariant unchecked → healthy-but-never-syncing deploys | Fail fast in prod without explicit escape hatch; boot-time base64url equality check in `env.ts` | S |
| **S4-F5** (+S4-F6) | Auth/import/export/token endpoints unthrottled (Better Auth limiter is prod-env-conditional); no request-body size limits | Explicit `rateLimit` config; reuse `RateLimiter` for the heavy endpoints; hono `bodyLimit` (2 MB upload / larger import) | S |
| **S6-F1** | Tier split nominal: Tier 0 = entire tree/edges/blocks; Tier 2 ≈ permanently tiny (only soft-deleted entries, which purge hard-deletes) — V8's cold-start motivation unmet, unmeasured | Move closed-old entries/completed subtrees/old layouts into `history` via date expressions; keep Tier 0 to the §7.3 bootstrap list; measure 100k cold-start | M |
| **S6-F2** | `command_results` stream syncs ≤90 days of full command payloads to every device; no client table can read them (grep-verified: zero client readers) | Drop the stream (response contract already closes the loop) — or window it + add the client table if a history UI is wanted (pairs with S4-F3 decision) | S |
| **S10-F1+S10-F2** | Docs drift: SECURITY_REVIEW overstates sync-down isolation testing + mobile export ✅, omits logout boundary; README/SELF_HOSTING present the unwired StatusIndex as shipped behavior | Reword/annotate all three; add the two-user bucket-isolation test (stack job already boots PowerSync) | S |
| **S1-F1** | turbo cache blind to `PRISMS_DB_TEST_URL`/`PRISMS_POWERSYNC_URL` — local green replays with integration suites skipped | `"env": [...]` on the `test` task (one line) | S |
| **S2-F2** (=S6-F5) | V5's additive-only guard (`isAdditiveSchemaChange`) is production-dead — migration 0009 will be verified by nobody | db test: per-`ROW_SCHEMA_VERSION` committed baseline shapes asserted via the existing core fn | S |

### Low (14 after merges)

| ID | Finding | Change |
|---|---|---|
| S2-F1 (+S2-F8, S4-handoff) | Double clock-in survivor is latest-wins with no `superseded` marker vs §7.10b's earliest-wins letter (deterministic either way; harness locks in latest) | **Decide:** amend spec (recommended — matches UX + shipped tests) or flip resolver + stamp provenance |
| S8-F4 (ex-S6-F3) | UI sibling tiebreak is `id`, not the spec'd `hlc` (client schema lacks `hlc`); convergent and stable either way; `layout.renormalize_order` unreachable end-to-end (S9-F6, S5) | Decide once: bless `(sort_order, id)` in the spec, or add client `hlc` + `compareSortKey`; wire or drop the renormalize verb |
| S7-F8 | HLC last-tick not persisted across restarts — backwards wall-clock across restart breaks same-device ordering silently (A2's little sibling) | Seed from `max(persisted tick, pending-queue max HLC, import floor)` |
| S7-F9 | Upload watch outlives `stop()`; rejected `client_commands` rows accumulate forever | Dispose the watch subscription; prune rejected >30 d |
| S8-F3 | PBKDF2 210k mis-cites OWASP SHA-256 floor (600k); decrypt honors uncapped file-supplied iterations (DoS nuisance) | Bump to 600k (envelope already versioned — zero migration); cap decrypt iterations ≤10 M |
| S4-F7 | No cross-batch per-device HLC floor (defense-in-depth; natural A1 companion) | Track last-applied HLC per (user, device); reject/park regressions |
| S4-F8 | Non-preempted DB error 500s the whole batch — poison-command wedge | Per-command try/catch → `rejected E_INTERNAL` + review item |
| S3-F6 | `node.retype` cascade-plan payload option unimplemented (rejection-only) | Decide: implement or amend spec to rejection-only |
| S3-F7 | User-authored `matches` regex evaluated in-txn with no complexity guard (ReDoS, self-DoS) | Cap pattern length; validate at rule-create; or RE2 server-side |
| S5-F6 (+S5-F9) | Job-tier efficiency: hourly all-users recompute (~24×), JS-side date filtering, row-by-row inserts, batch-fail granularity | Day-reset gating; SQL-side due-date filter + index; batch inserts; per-job try/catch |
| S5-F7 | 90-day `command_log` purge also erases user-facing history (R9) — mechanically safe (no FK), product stance undecided | Decide history retention explicitly (A5 is the designed vehicle) |
| S6-F4 | `FOR ALL TABLES` publication replicates auth/sessions/push-keys/pg-boss churn through PowerSync's slot | Scope to the 22 synced tables (verify PowerSync's published-set⊇rules requirement in docs) |
| S10-F4 (+S9-F5) | Prod nginx: no security headers/asset caching/TLS docs; Tauri: `csp: null`, empty plugins registration, `withGlobalTauri` | Header + cache block in `web.conf`; document TLS termination; set Tauri CSP, verify notification plugin on first desktop runtime pass |
| S10-F6 (+S10-F7, S9-F4, S1-F2/F3/F4/F5/F9, S10-F9) | Hygiene batch: single-stage server Dockerfile (whole-repo image, no layer cache); PWA `icons: []` (not installable); web PowerSync default port 8081 vs compose 8080 (+CI remap workaround); `passWithNoTests` in web; apps over-permitted to import `db`; §15 root aliases missing; `@types/node` skew; no `.nvmrc`; stale compose TODO; restore.sh doesn't stop api | One hygiene PR: multi-stage Dockerfile, manifest icons, port default 8080 + delete CI remap, `passWithNoTests: false` (web), lint allow-list trim, root aliases, types pin, `.nvmrc` 24, comment/doc touch-ups |

### Info / observations (9)

S1-F8 + S5-F9 + S6-F6 accepted deviations (→ §2) · S2-F5 (StatusIndex fabricates rows on unknown-row updates — guard when wiring W1) · S2-F7 (agenda budget observed ~65 ms, soft-asserted — documented rationale) · S2-F9 (O(N²) focus sweep, N small) · S4-F9 (server-minted layout ids — client deliberately masks; benign) · S4-F10 (`E_NOT_FOUND` vs `E_OWNERSHIP` oracle — negligible with UUIDs) · S5-F9 (dry-run conflict check user-scoped vs restore's global — preview nit) · S8-F6 (read-path bundle: tombstone under-count transient, cache growth bounded) · S10-F8/F9 (DoF 23 acceptance decision needed; small docs accuracies).

---

## 4. Remediation backlog (ordered, PR-sized)

**Batch 0 — decisions (no code).** (1) Double clock-in survivor: bless latest-wins in the spec or flip the resolver (S2-F1). (2) Sort tiebreak: bless `(sort_order, id)` or add client `hlc` (S8-F4); wire-or-drop `layout.renormalize_order`. (3) `command_log.effects`: populate or amend spec (S4-F3) — decides S6-F2's stream shape too. (4) History retention window (S5-F7). (5) DoF 23: accept the documented mobile/desktop exception or stand up an emulator runner (S10-F8). (6) Record the accepted deviations list (§2) in the Blueprints.

**Batch 1 — small correctness, big product truth (1 PR each, ~a day):**
1. **Weather out of acceptance** (S3-F1) + harness 13b. *Unblocks R19/V10 compliance.*
2. **Union-not-sum consumed** (S3-F2/S5-F4) + scenario-9 aggregate assertion. *Fixes silent value corruption on both tiers at once.*
3. **Upload chunking + 4xx surfacing** (S7-F2) + 150-pending regression.
4. **Logout boundary** (S9-F1/S8-F2) + SECURITY_REVIEW §7 update.
5. **Review lifecycle wiring** (S5-F1) — 3 lines + purge list.
6. **`replaces_block_id` stamping** (S5-F2) + accept-double-book scenario; **notification watermark** (S5-F3).

**Batch 2 — client write-path completion (one workstream, shared plumbing):** merged-`FactRows` access in `execute()` → invariant pre-flight (S7-F4) → offline spawning (S7-F1) → soft-delete closure (S7-F7) → `depends_on` derivation (S7-F5). Then the **version envelope pair, strictly ordered:** client sends versions (S7-F3) → server rejects absent (S4-F1).

**Batch 3 — mobile viability:** quick-crypto polyfill (S9-F2) → React peer-dependency restructure (S9-F3) → `expo-doctor` + first real device run → run the existing Maestro flow → then adjudicate DoF 23.

**Batch 4 — the StatusIndex wiring (W1, the big one):** fan-out scoping (S2-F4) + unknown-row guard (S2-F5) → client provider incremental apply (S8-F1) → server batch-memoized context (S4-F2 short-term) → server write-path 100k perf test → *then* the README/SELF_HOSTING claims become true (S10-F2).

**Batch 5 — sync topology + server hardening:** real Tier 2 + Tier 0 trim + cold-start measurement (S6-F1) · drop/window `command_results` (S6-F2) · publication scoping (S6-F4) · prod fail-fast + jwks check (S4-F4/S10-F5) · rate/body limits (S4-F5/F6) · poison-batch catch (S4-F8) · nginx headers/caching (S10-F4) · regex guard (S3-F7).

**Batch 6 — reconcile/robustness (Annex-A-shaped):** applied-tombstone reconcile (S7-F6 → A3) · HLC tick persistence (S7-F8 → A2) · upload lease/backoff/watch-disposal (S7-F9 → A4) · per-device HLC floor (S4-F7 → A1-lite) · `template_version` stamping (S3-F4) · SF/SS lag (S3-F5) · additive-schema gate (S2-F2) · isolation bucket test (S10-F1) · aggregates isolation level (S5-F5).

**Batch 7 — hygiene sweep:** the S10-F6 consolidated list (Dockerfile, icons, port default, turbo env, aliases, pins, docs).

## 5. Test-gap appendix (§15 gates without an enforcing test)

From S10's full gate map (all other gates have named enforcing tests, verified green):

1. **Sync-down cross-user isolation** — no dynamic test at any layer; static stream-rule audit only (S10-F1/F3a).
2. **Union-not-sum as a product outcome** — scenario 9 asserts the resolver, production aggregates bypass it (S10-F3b).
3. **External-fact divergence at the acceptance path** — scenario 13 never exercises a weather-blocked clock-in (S10-F3c).
4. **Absent-version envelope floor** — untested (and real clients send no versions at all) (S10-F3d).
5. **>100 pending upload** — no regression (S10-F3e).
6. **Server write-path perf @100k** — no test (S4-F2); client cold-start @100k — no measurement (S6-F1).
7. **Accept-suggestion double-book** — no scenario (S5-F2 handoff).
8. **Prod compose image build** — never built in CI (config-validated only).
9. **§15 root command aliases** — partial (S1-F4); capabilities exist behind filters.
10. **Mobile/desktop smoke flows** — artifacts exist, no runner executes them (S10-F8).

## 6. Annex A adoption recommendation (post-v1.4 backlog)

Verdicts with rationale in S10 §Annex-A: **adopt next** — A2 clock-skew guard (closes S7-F8's class + a documented residual risk; small), A4 crash recovery (the designed umbrella for the S7-F2/F9 fixes; half-built already). **Adopt soon** — A3 applied-overwritten (S7-F6's proper fix builds 80% of it), A8 diagnostics (cheap; would have made S7-F2 user-visible). **Adopt when deciding history retention** — A5 compaction/redaction (the S5-F7 vehicle). **Defer** — A1 device registry (post-v1 multi-device value), A6 import modes (current restore+skip is safe and honest), A7 local search (product feature, real per-platform cost).

---

*Every statement above traces to a session report (S1–S10) or to code re-read during synthesis. Sessions 1–10: `session-01-foundation.md` … `session-10-security-perf-docs.md`; matrix: `00-feature-matrix.md`; tracker: `AUDIT_PLAN.md`.*
