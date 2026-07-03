# Audit Session 3 — Core Engines: Commands, Rules, Scheduler, Aggregates, Graph

Audited at commit `29f55d8` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-01.

**Scope examined:** `packages/core/src/commands/{payloads,envelope,invariants}.ts`, `rules/{engine,actions,validate}.ts`, `status/predicate.ts` (the shared evaluator — §10's heart), `scheduler/{placement,types}.ts` (+ optimize determinism surface), `aggregates/{effective,practice,progress,burndown,streaks,timeleft,occurrences}.ts` (targeted), `graph/elk.ts`, `domain/ids.ts`; tests `commands/catalog.test.ts`, `scheduler/{greedy,optimize,placement}.property.test.ts`, `rules/determinism.property.test.ts`; plus cross-tier greps into `apps/server/src/dispatcher.ts` and `packages/ui` where a core contract's consumers determine the verdict.

**Verdict:** the engines are well-built and unusually well-tested — the catalog exceeds §8 with completeness/strictness/minimal-field tests, every §6.7 invariant has a rejecting test, all four §7.6 placement gates are exact with per-edge-type property tests, and the rules engine is deterministic by construction with replay-aware drift support. But this session found the audit's two most serious issues so far, both of the same species as S2's findings — **correct primitives that production doesn't consume**: effective hours ignore the union resolver and double-count overlapping entries (§9.2 violation), and the server's clock-in gate consumes weather-derived blocking (V10/R19 violation).

---

## Findings

### S3-F1 · High — server clock-in acceptance gate includes weather-derived blocking (V10/R19 violation)

**Evidence:** `apps/server/src/dispatcher.ts:697-700` — `if (!p.force && isBlocked(task, await loadFactContext(tx, userId), nowMs)) return reject('E_BLOCKED_TASK', …)`. `isBlocked` (`packages/core/src/status/status.ts:79-87`) includes `evaluateBlockerRules`, and the predicate evaluator resolves `weather.*` facts to concrete values when a weather row is present (`status/predicate.ts:140-159`) — a known-true weather predicate lands in `blockedBy` → `blocked: true` (`predicate.ts:343-358`). §10.3: external-fact results "must never cause a command to be rejected"; §9.1: "Weather-derived blocking is advisory display only and never participates in command acceptance"; R19 verbatim. (Unknown/absent weather is handled correctly: → `unverified`, not blocked.)

**Failure mode:** user has a blocker rule "block outdoor tasks when precipitation ≥ 60%". Device A's weather fact is stale/absent → task displays available (with the unverified badge) → user clocks in without `force` → the server, whose weather fact says 70%, rejects `E_BLOCKED_TASK` → optimistic rollback + review item. Command acceptance now depends on server-side weather freshness — the exact spurious-rejection class V10 prohibits, and it will fire in practice for any weather-rule user.

**Suggested change:** core should export an acceptance-safe evaluation: an AST walk `referencesExternalFacts(predicate)` (the parseable predicate schema makes this trivial — flag any `fact` starting with `weather.` or a future external namespace), and either an `evaluateBlockerRules(…, {excludeExternalFacts: true})` option or an `isBlockedForAcceptance()` that uses `dependencyBlocked` + non-external `blockedBy` only. The dispatcher's `E_BLOCKED_TASK` check then uses the acceptance-safe variant; the display path keeps the full evaluation. Document the consequence: a weather-blocked task clocks in *without* force (weather is advisory), while dependency/non-external-rule blocking still requires `force`. **Handoff (S4):** apply/verify at the dispatcher; check whether any *other* acceptance path consumes `isBlocked`. **Handoff (S10):** the convergence harness's weather-divergence scenario should assert this exact case (non-force clock-in accepted under divergent weather).

### S3-F2 · High — effective hours/progress double-count overlapping entries: `mergeTimeEntries` has zero production consumers (§9.2 violation)

**Evidence:** §9.2: "Effective hours specifically **must consume the timer-merge resolver (§7.10b)** so overlapping intervals union rather than sum." Grep across all `src/`: `mergeTimeEntries` is consumed by nothing outside its own module and tests. Instead: `aggregates/practice.ts:50` sums `effectiveMinutes(entry)` per entry; `aggregates/progress.ts:35,43` sums `rawMinutes(entry)` per entry; `packages/ui/src/hooks.ts:726` sums per-entry raw minutes for the dashboard's today-total. `merge/time-entries.ts:3` describes itself as "the SINGLE source of truth for effective hours" — it is a source of truth for nobody.

**Failure mode:** two devices offline both clock in *and out* on the same task: entries 09:00–11:00 and 09:30–10:30. Both rows are closed facts — the §7.4 open-timer resolver never touches them (it resolves open-open only). After sync, progress shows 150 consumed minutes instead of 120; practice hours and levels inflate; the dashboard today-total inflates. Every device converges to the same **wrong** number, silently. (Note the open-open case self-heals: `resolveOpenTimeEntries` closes the loser at the winner's start, leaving no overlap — which is precisely why only the closed-closed case bites, and why tests that only exercise double *open* timers won't catch it.)

**Suggested change:** group a task's entries and consume the resolver: `progress` uses `mergeTimeEntries(entries).rawMinutes` per task; `practice` unions per task then sums across tasks; `hooks.ts:726` unions per task per day (keeping the live-elapsed add-on for the open entry). The per-entry helpers in `aggregates/effective.ts` can remain for single-entry display but should stop being the aggregation path (rename or document accordingly). **Handoffs:** S5 — how does `aggregates-recompute` compute hour metrics server-side (if it also sums per-entry, canonical aggregates are wrong too); S10 — verify the harness's "union-not-sum" scenario asserts an *aggregate* value, not just the resolver's own output.

### S3-F3 · Medium — the client never runs invariant checks (§8 requires them "against merged state on the client")

**Evidence:** §8: invariant checks "run against merged state on the client, against Postgres state on the server". Grep for every `check*` invariant function across all `src/`: consumers are core itself, core tests, `apps/server/src/dispatcher.ts` (24 refs), and `automation-backstop.ts` — **zero references in `packages/ui` or any app client code**.

**Failure mode:** an invalid command — clock-in on a task another device just completed, an I1-violating move from a stale view — is queued and optimistically applied: the UI shows success (timer running, node moved), possibly for hours offline, then the server rejects on reconnect → rollback + review item. The spec's design gives the user an instant, local rejection instead of a delayed surprise revert.

**Suggested change:** in the ui `execute()` path, run the verb's checker against the merged FactContext before writing overlay effects or enqueueing the envelope; a failure surfaces as an immediate command error (no envelope, no review item). The functions are already pure and tier-agnostic — this is wiring, not new logic. **Owned by S7** (execute path) for the integration point; filed here because the cross-tier evidence is definitive.

### S3-F4 · Medium — `template_version` is read but never defined or stamped (V6 attribution half missing)

**Evidence:** §10.2: "action templates carry a `template_version` constant in code", spawned-row provenance records `rule_version` **and** `template_version` in `source_detail`, and drift items record "both versions and both content hashes". Reality: no `TEMPLATE_VERSION` constant exists anywhere (repo-wide grep); the engine's `SpawnProvenance` carries `{id, rule_id, slot}` only (`rules/engine.ts:50-55`); the backstop stamps `rule_version` only into drift detail (`apps/server/src/jobs/automation-backstop.ts:161`); yet `packages/ui/src/provenance.ts:57-58` *reads* both fields from `source_detail` — `template_version` is permanently undefined. The robust half of V6 (canonical content comparison via `spawnedNodeContent`/`spawnedEdgeContent`, fixed key order) is properly built.

**Failure mode:** a drift review item can say *that* content differs but not *which template generation* produced each side; the provenance "why?" panel shows a blank where the template version should be. No convergence impact.

**Suggested change:** `export const TEMPLATE_VERSION = 1` in `rules/actions.ts`; add `rule_version`/`template_version` to `SpawnProvenance`; stamp both into `source_detail` at the server write sites; include both in `automation_drift` detail. **Handoff (S4/S5):** the two stamping sites (dispatcher fixpoint, backstop).

### S3-F5 · Medium — started-based lag is not enforced: SF completion lag and SS availability lag are dropped

**Evidence:** §7.6: SS "blocks availability until predecessor has started **plus lag**"; SF "blocks completion until predecessor has started **plus lag**". Implementation: `commands/invariants.ts:211-213` (SF completion gate checks bare started-ness; FS/FF correctly apply lag at `:209`) and `status/status.ts:59-73` (SS availability checks bare started-ness; the lag clause at `:67-73` applies only from `completed_at`). Root cause is structural: `FactContext.hasAnyEntry` is a boolean — the earliest `started_at` isn't available to either gate. The test suite mirrors the gap (catalog.test's SF case has no lag variant; status.test's SS lag test uses a *completed* predecessor).

**Failure mode:** an SF edge with `lag_minutes: 60` lets the successor complete the moment the predecessor starts; an SS edge with lag unblocks the successor immediately on predecessor start. Deterministic (both tiers share the code) but contrary to §7.6's stated semantics.

**Suggested change:** extend `FactContext` with `earliestEntryStart(nodeId): Instant | undefined` (both `buildFactContext` and `StatusIndex` maintain it cheaply), then enforce `now < started_at + lag → blocked` in both gates; add the two missing lag tests.

### S3-F6 · Low — `node.retype` cascade plan option not implemented

**Evidence:** §8: retype rejects on orphaned child types "unless the payload includes an explicit cascade plan". `nodeRetypeSchema` is `{id, node_type}` only (`payloads.ts:49`); `checkNodeRetype` rejects with `E_INVALID_RETYPE_CHILDREN` unconditionally (`invariants.ts:99-108`, correctly tested).

**Suggested change:** either add the cascade-plan payload (and its invariant path) or amend the spec to rejection-only and document the workaround (move/retype children first). Decision item, not a bug.

### S3-F7 · Low — user-authored `matches` regex evaluated without complexity guard (ReDoS surface)

**Evidence:** `status/predicate.ts:234-241` — `new RegExp(expected, 'i')` on rule-author-supplied patterns, evaluated server-side inside dispatcher transactions (blocked gate, automation conditions) and in jobs. Pattern length/complexity is uncapped by `predicateSchema`; JS regex has no timeout, and a catastrophic-backtracking pattern against a long title spins CPU inside the command path.

**Suggested change:** cap pattern length in the condition schema (e.g. ≤200 chars) and validate patterns at `rule.create`/`blocker.create` time with a linear-time safety check (or evaluate via RE2 server-side). Single-user self-DoS mostly, but it runs in the trusted tier.

### S3-F8 · Low — weather predicates are legal in automation *conditions* (V10 letter tension)

**Evidence:** `rules/engine.ts:155` evaluates rule conditions with the full fact registry, including `weather.*`. A weather-conditioned rule's spawn set then depends on the server's weather at apply time. No divergence (the server evaluates once, authoritatively, and clients reconcile to it), and unknown weather conservatively doesn't fire — but V10 says external facts must "never change a convergent canonical outcome", and a spawned task is exactly that.

**Suggested change:** decide deliberately: forbid external-fact namespaces in automation conditions at `validateAutomationRule` (cheap, keeps V10 absolute), or amend V10 to scope the prohibition to command acceptance/rejection and document server-authoritative evaluation for automation. Pairs with F1's evaluator work either way.

### S3-F9 · Info — envelope `command_version`/`schema_version` are optional; server defaulting is the enforcement point

**Evidence:** `commands/envelope.ts:24-26` — both optional. Core's `isClientTooOld` is strict, but an absent `schema_version` must not default in a way that bypasses the §7.11 floor. **Handoff (S4):** verify the dispatcher's defaulting (absent → treated as below-floor, or as 0, or rejected — anything but silently-current).

---

## Compliance checklist results

| Check (playbook §S3) | Result |
|---|---|
| Catalog vs §8 list | **PASS** — all 50 spec verbs present + 7 `tag.*` + 2 `review.*` (59); completeness asserted by `catalog.test.ts:33`; no undelete/restore verb (S2-F5 assumption confirmed) |
| Zod schema per command, strict, minimal-field | **PASS** — every schema `strictObject`; tests assert extra-key rejection and "rejects any field the verb does not name — no full-row write" |
| Envelope identity (§7.2b) | **PASS** — client UUIDv7 id + HLC + `depends_on`; version fields optional → F9/S4 |
| Invariants have rejecting tests (§15) | **PASS** — I1–I8, I10 each tested (`catalog.test.ts:96-192`); move/retype revalidation tested; SF-lag gap → F5 |
| §7.6 completion gates | **PARTIAL** — FS/FF+lag exact, SS exempt ✓; SF lag dropped → F5 |
| §7.6 placement gates (scheduler) | **PASS** — all four exact incl. FF/SF finish-translation (`placement.ts:132-145`); per-edge-type property tests |
| Rules: UUIDv5 ids, trigger-time timestamps, MAX_DEPTH=5 fixpoint | **PASS** — `uuidV5(rule:trigger:slot)` under locked `PRISMS_NS`; timestamps from triggering fact; precise `depthLimited`; shuffled-rule-order byte-identical property test |
| V6 drift support | **PARTIAL** — canonical content strings + `replayedNodes` replay channel ✓; `template_version` phantom → F4 |
| Self-trigger rejection | **PASS** — transitive, conservative tri-state analysis (`validate.ts`), exceeds spec; tested |
| V10: external facts never gate/diverge | **FAIL** at the acceptance gate → F1 (High); automation-condition tension → F8; unknown-weather → unverified handled correctly |
| Scheduler determinism + property tests (§15: overlap, anchoring, dependencies, idempotency) | **PASS** — greedy + optimize both property-tested on all four; optimize randomness is injected/seeded Rng only |
| Aggregates pure, §9.2 set present, `bucketDate` for "today" | **PARTIAL** — all §9.2 aggregate modules exist and are pure; burndown/streaks/timeleft use `bucketDate` ✓ (occurrences' `new Date(ms)` is value-construction for rrule, fine); **effective-hours union mandate violated → F2 (High)** |
| Graph: `elk.ts` must not import elkjs | **PASS** — pure layout-graph builder; elkjs stays in server/client callers |
| `domain/ids.ts` injected randomness only | **PASS** — UUIDv7 from injected Clock+Rng; PRISMS_NS derivation locked by test |
| Client runs invariants against merged state (§8) | **FAIL** → F3 |

## Positive observations

- `catalog.test.ts` is a model §15 gate: catalog completeness, strict-object sweep, minimal-field enforcement, and one rejecting test per invariant, by number (I1–I10).
- The FF/SF placement translation (`bound = span.end + lag − durationMs`) is the subtle part of §7.6 most implementations get wrong; here it's exact and property-tested per edge type.
- `topoOrder` is deterministic *and* efficient (priority+id tiebreak, binary-insert ready queue), and `optimize` confines randomness to an injected seeded Rng — same inputs, byte-identical plans.
- The engine's replay path (`replayedNodes` + cascade-through-the-real-row) is a thoughtful solution to "complete partially-synced automation without duplicating it".
- `validateAutomationRule`'s transitive self-trigger analysis (synthetic-spawn tri-state matching) goes beyond the spec's requirement and fails conservative.

## Matrix updates applied (sequential mode)

- V10 → ⚠️ (S3-F1 High: acceptance gate consumes weather-derived blocking; S3-F8 automation-condition tension)
- R19 → ⚠️ (same)
- V6 → ⚠️ (content-comparison half verified in core; `template_version` phantom — S3-F4; backstop behavior → S5)
- R7 → ✅ core-side (status S2 + aggregates/scheduler S3 all client-computable offline; F2 affects correctness, not offline capability)

## Handoff items

1. **S4:** fix/verify the acceptance-safe blocked evaluation at `dispatcher.ts:697-700` (F1); check no other acceptance path consumes full `isBlocked`.
2. **S4:** `loadFactContext(tx, userId)` runs inside the command txn per clock-in (`dispatcher.ts:699`) — this is S2-F3's server half, now with hard evidence; quantify what it loads at 100k rows.
3. **S4:** envelope version defaulting (F9); trust-strip must cover `applied_at` (carried from S2); supersession provenance for the timer loser (carried from S2-F1).
4. **S4/S5:** template_version stamping sites (F4); S5: does `aggregates-recompute` sum per-entry hours (F2's server half)?
5. **S5:** import table-name allowlist (carried from S2).
6. **S7:** client-side invariant pre-flight in `execute()` (F3); `depends_on` derivation rules per §8 for commands referencing locally-created rows.
7. **S10:** harness scenarios — weather-divergence must assert non-force clock-in acceptance (F1); union-not-sum must assert an aggregate value (F2).

**Next:** Session 4 — server dispatcher & trust boundary (`apps/server/src/{dispatcher,app,auth,env,rate-limit,request-log,main,index}.ts`) against §7.2b–e, §7.5, §7.8, §7.11, §10.1, R6/R17/R18, V2–V4.
