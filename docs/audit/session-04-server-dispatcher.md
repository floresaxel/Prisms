# Audit Session 4 — Server: Dispatcher, Trust Boundary, Auth

Audited at commit `8fb4b6b` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-02.

**Scope examined:** `apps/server/src/dispatcher.ts` (all 1396 lines: pipeline, 59 handlers, LWW machinery, automation-in-txn), `app.ts`, `auth.ts`, `env.ts`, `rate-limit.ts`, `request-log.ts`, `main.ts`; spec §7.2a–f read in full.

**Verdict:** the dispatcher is the most carefully engineered file in the repo — the §7.2 contract is implemented essentially to the letter: strip-trust-fields-*before*-validation, user-scoped dedup→noop with a unique-violation race fallback, exact §7.2e causal gates, per-field HLC-LWW with materiality-checked `hlc_conflict` items, the full six-step §7.5 suggestion transaction, and §10.1 automation-to-fixpoint inside the command txn behind a SAVEPOINT with I1/I3 spawn validation. V2/V3/V4 verify clean. The findings are: one latent floor bypass, a real scale cliff (per-command full-context loads), an empty `command_log.effects` channel, and boundary hardening (auth rate limiting, body limits, dev-secret fallback).

---

## Findings

### S4-F1 · Medium — absent `schema_version` bypasses the §7.11 floor (S3-F9 confirmed)

**Evidence:** `dispatcher.ts:1293` — `if (cmd.schema_version !== undefined && isClientTooOld(...))`. The envelope schema makes `schema_version` optional (`core/commands/envelope.ts:26`); a command that omits it skips the `client_too_old` gate entirely and is logged with `schema_version: cmd.schema_version ?? 1` (`:1334`).

**Failure mode:** harmless today (floor = 1, all v1 clients send 1). The day the floor rises to 2, any client that omits the field — including the very old clients the floor exists to stop — sails through and is "applied by guesswork", the exact outcome §7.11 forbids. Same pattern for `command_version ?? 1` at log time (no migrators exist yet, so currently moot).

**Suggested change:** treat absent as below-floor: `const sv = cmd.schema_version ?? 0;` then gate unconditionally. One line, converts a latent trap into spec behavior.

### S4-F2 · Medium — per-command full-context loads inside the transaction: the server write path has a 100k-node cliff (S2-F3 server half, quantified)

**Evidence:** `loadTree` (`:185-186`) selects **every node the user owns** per `node.create`/`move`/`retype`/`soft_delete`/`activity.promote`/`habit.create`; `loadFactContext` (`:191-212`) runs **nine sequential full-table SELECTs** (nodes, edges, time_entries, schedule_blocks, sprints, memberships, blocker_rules, external_facts, settings) per non-force `timer.clock_in` and per gated completion (`completionGate` `:402-405`); `runAutomationInTx` (`:227-231`) reloads nodes+edges+rules for every task-created/completed command. Nothing is cached across the ≤100 commands of a batch.

**Failure mode:** at the spec's own 100k-node scale, a single check-off with predecessors pulls ~100k+ rows through 10 sequential round-trips *inside the open transaction*; a 100-command batch repeats this up to 100×. Long transactions on hot tables also stretch PowerSync's logical-replication lag. The M15 perf gate covers `StatusIndex.apply` (client-shaped), not this path — the "100k budgets met" claim does not extend to the server write path.

**Suggested change:** short term, add a per-batch memoized context (tree/edge index/FactContext keyed by userId, invalidated when a handler writes the underlying table — commands in a batch already apply sequentially); parallelize the 9 SELECTs (`Promise.all`); replace full-tree loads for invariants with targeted queries (parent row + child types). Long term this is the same seam as S2-F3: a server-side StatusIndex/context maintained incrementally. Add a server-write-path perf test at 100k.

### S4-F3 · Medium — `command_log.effects` (and `parent_command_id`/`triggering_command_id`) are never written (§7.2f / R9 partial)

**Evidence:** §7.2f: "`effects` stores a compact summary of rows created, updated, deleted, superseded, or rejected"; command logs "must be sufficient to explain automation provenance, conflict resolution, and server rejection reasons". Both `command_log` inserts (`:1326-1339`, `:1208-1221`) omit `effects` (defaults `'[]'`) and never set `parent_command_id`/`triggering_command_id`.

**Failure mode:** no convergence impact — row-level explainability survives via `created_by_command_id`/`last_modified_by_command_id` and automation `source_detail` (this is what the WhyButton reads). But the command-level channel the spec designed for "what did this command actually change?" (undo groundwork, debugging, history UI) is permanently empty; a future history/undo feature has nothing to read.

**Suggested change:** have handlers accumulate a compact effect summary (`{table, row_id, op, fields: [names]}` — the shape already exists as the client's `OverlayEffect`) and write it in the same txn; stamp `triggering_command_id` on automation-spawn summaries. Alternatively amend the spec to drop the column — decide, don't leave a dead column that looks load-bearing.

### S4-F4 · Medium — dev-secret fallback only warns; a prod misconfiguration boots with a publicly-known JWT signing key

**Evidence:** `env.ts:43-49` — `POWERSYNC_JWT_SECRET ?? DEV_POWERSYNC_SECRET` / `BETTER_AUTH_SECRET ?? DEV_AUTH_SECRET` with a `console.warn`. The dev PowerSync secret is committed to the repo (`env.ts:10`) and matches `infra/powersync/powersync.yaml`.

**Failure mode:** if the env var doesn't reach the API container — a real risk given the recent `.env` rename to `PS_JWT_*` (commit `2ab3bf7`) while `env.ts` still reads `POWERSYNC_JWT_*` — production signs PowerSync tokens with a public key. Anyone can mint a JWT for any `sub` and download that user's buckets. The only signal is one warning line in logs.

**Suggested change:** fail fast when `NODE_ENV === 'production'` and either secret is the dev default (with an explicit `PRISMS_ALLOW_DEV_SECRETS=1` escape hatch for smoke tests). **Handoff (S10):** verify `docker-compose.prod.yml` actually maps the renamed `PS_JWT_*` values into the API's `POWERSYNC_JWT_*` variables.

### S4-F5 · Medium — auth, import, export, and token endpoints have no explicit rate limiting

**Evidence:** the app-level limiter throttles dispatcher verbs only (`dispatcher.ts:1364-1369`). `betterAuth()` is configured without a `rateLimit` option (`auth.ts:22-37`) — Better Auth's built-in limiter defaults to enabled *only* when `NODE_ENV=production`. `/sync/import` (a full restore transaction), `/sync/export` (full-account serialization), and `/api/powersync/token` are unthrottled.

**Failure mode:** login brute-force protection depends on an env var being set somewhere else; an authenticated (or scripted, for auth endpoints) client can hammer the heaviest endpoints in the API.

**Suggested change:** pass an explicit `rateLimit: { enabled: true, … }` to `betterAuth`; reuse the existing `RateLimiter` for `/sync/import`, `/sync/export`, and the token endpoint (per-user keys, generous limits — e.g. 5 imports/hour).

### S4-F6 · Low-Medium — no request-body size limits

**Evidence:** `app.ts:110-156` — `c.req.json()` on `/sync/upload` and `/sync/import` with no `bodyLimit` middleware; `@hono/node-server` imposes none by default. The envelope caps commands at 100 but each payload is unbounded JSON.

**Suggested change:** hono's `bodyLimit` — e.g. 2 MB for `/sync/upload`, a deliberate larger cap for `/sync/import` (exports are legitimately big). Authenticated-only surface (requireSession runs before parsing) keeps this Low-Medium rather than High.

### S4-F7 · Low — cross-batch per-device HLC ordering is not enforced

**Evidence:** `handleUpload` sorts within the batch (`:1372`) but keeps no per-device high-water HLC; a batch whose commands are all older than a previously-applied batch from the same device applies anyway. §7.2e says commands "are applied server-side in HLC order per device". In practice the client watcher uploads sequentially in order, per-field LWW makes stale writes lose, and the causal gate gates references — so this is defense-in-depth, not a live bug.

**Suggested change:** track last-applied HLC per (user, device) — a natural companion to Annex A1's device registry if it's ever adopted — and reject (or park) regressions with a typed code.

### S4-F8 · Low — a non-preempted database error aborts the whole upload as a 500 (poison-batch wedge)

**Evidence:** `handleCommand:1349-1355` catches only unique violations (dedup race → noop); any other throw propagates, Hono 500s, and the client's response for already-committed commands in the batch is lost (dedup makes the retry safe). Handlers preempt most FK/constraint failures with existence+ownership checks, so the residual trigger set is small — but a command that reliably throws wedges its device's queue forever (client retries in order, server 500s every time).

**Suggested change:** wrap the per-command execution in try/catch → `rejected` with `E_INTERNAL` + review item (the txn guarantees no partial effects), keeping the batch flowing.

### S4-F9 · Info — server-minted `randomUUID()` for upsert-by-pair rows breaks optimistic id prediction for layouts

**Evidence:** `layout.set_position`/`set_collapsed` (`:1087,1106`) create `diagram_layouts` rows with a server-generated id when no pair exists. The client cannot predict this id in its overlay effect. Layout rows are cosmetic and LWW-converged by pair, so the worst case is transient identity churn on reconciliation. **Handoff (S7):** check how the client builds the optimistic layout effect (pair-keyed synthetic row?) and whether reconciliation cleans it up.

### S4-F10 · Info — `E_NOT_FOUND` vs `E_OWNERSHIP` distinguishes whether a row id exists under another account

**Evidence:** `ownershipReject` (`:134-138`) and the cross-user command-id probe (`:1286-1288`). UUIDs are unguessable, so the oracle is negligible; S10's threat pass may prefer collapsing both to a uniform not-found.

---

## Resolved handoffs (from S2/S3)

| Handoff | Resolution |
|---|---|
| Trust-strip covers `applied_at` + full list (S2) | **PASS.** Strip-before-parse (`:1310-1313`, §7.2c letter); every payload schema is strict, so any trust field not in the strip list (e.g. `applied_at`, `computed_by`) is *rejected* rather than smuggled — belt and suspenders. Handlers assign `sys`/`born` server-side; `user_settings` exemption documented. V4/R17 verified. |
| Supersession provenance on the losing double clock-in entry (S2-F1) | **CONFIRMED ABSENT.** The loser is closed with `ended_at` + `completed_session: null` (`:735,738`) — no superseded marker, no provenance pointer. Feeds the S2-F1 spec-vs-code reconciliation decision. |
| Does the dispatcher build a full FactContext per command? (S2/S3) | **YES — quantified as S4-F2.** |
| Envelope version defaulting (S3-F9) | **CONFIRMED as S4-F1.** |
| Acceptance-safe blocked evaluation single-site? (S3-F1) | **YES** — `isBlocked` is consumed only at `timer.clock_in` (`:699`); the V10 fix is one call site + one core helper. |
| LWW delete-resurrection (S2-F6) | **SAFE** — no undelete verb exists; `deleted_at` only transitions null→set; per-field LWW cannot resurrect. `soft_delete` bypasses LWW (unconditional set) which is convergent given monotone deletes. |
| template_version stamping site (S3-F4) | **CONFIRMED** — `stampProv` (`:276-288`) writes `source_detail` with trigger ids + slot, no `rule_version`/`template_version`. |

## Compliance checklist results

| Check (playbook §S4) | Result |
|---|---|
| Envelope Zod-validated before any DB touch; unknown command → typed rejection | **PASS** (`:1360`, `:1306-1309`); payload size unbounded → F6 |
| Idempotency: dedup by client id, noop + original result, 90-day content | **PASS** — user-scoped probe, `noop`+`original_result`, 23505 race fallback (`:1282-1290`, `:1350-1353`); retention itself → S5 |
| Causal ordering (V3): HLC order, `dependency_rejected` + linked review item, user-scoped | **PASS** — in-batch sort + batch/log-aware `causalReject`, `E_UNKNOWN_TARGET` for unknown/out-of-order deps (`:1259-1273`); review item per rejection (`:1381`); cross-batch device floor absent → F7 |
| Trust strip (V4/R17) for every path incl. automation + review commands | **PASS** — see handoff table; automation rows stamped via `stampProv`; review.resolve assigns status/resolved_at server-side |
| §7.5 txn shape: revalidate → minimal writes → automation fixpoint in-txn → command_log id=client id → single commit | **PASS** — one `db.transaction` wraps handler + `runAutomationInTx` + `command_log` insert (`:1322-1341`); SAVEPOINT isolates automation (`:295-306`); spawn I1/I3 validation + dangling-edge drop (`:261-270`); `depthLimited` → `sync_warning` (`:238-253`); V2 exact (`:1327`, `:1346`) |
| `accept_suggestion` §7.5 rules | **PASS** — all six steps in order (`:613-677`): stale → `E_STALE_SUGGESTION` (→ `stale_suggestion` item), done-task reject, replaced-block soft-delete, anchored-overlap reject (I9), promote (clears suggestion metadata), supersede overlapping same-task suggestions; idempotent re-accept → applied no-op |
| Schema floor §7.11 | **PARTIAL** — enforced when the field is present; absent bypasses → F1; floor is a code constant (`MIN_CLIENT_SCHEMA_VERSION`) |
| Auth: session → short-lived PowerSync JWT (aud/kid/sub/exp) | **PASS** — HS256, TTL 300s, aud+kid from env (`app.ts:94-108`); no `iss` claim → S6 must confirm powersync.yaml doesn't expect one; CSRF origin check pinned on (`auth.ts:35`); rate limiting explicitness → F5 |
| Request-log redaction | **PASS by construction** — method/path/status/ms only, query string dropped |
| No generic update endpoint (DoF 2) | **PASS** — routes: health, auth, token, upload, export, import; the only row-write paths are named commands and the §13.1 import txn |
| Per-command rejection → durable review item (R12 server side) | **PASS** — every rejection path creates a linked open item (`:1378-1381`, `reviewItemFor` mapping incl. `schema_version_block`) |
| `hlc_conflict` on material LWW loss | **PASS** — strictly-older + value-differs guard, losing value preserved in detail, safe identifier quoting (`:317-347`) |

## Positive observations

- Strip-**then**-validate (`:1310-1313`) implements the §7.2c subtlety most readers miss, and strict schemas make the strip list's completeness non-critical — unlisted trust fields get rejected, not accepted.
- The dedup design is race-correct: the 23505 catch converts a concurrent duplicate upload into the stored outcome instead of a 500.
- `lwwFields` ties (`hlc === current.hlc`) are treated as idempotent replays — no write, no spurious conflict item — which is exactly right for at-least-once delivery.
- The §7.4 clock-in resolution normalizes postgres-js timestamp strings to ISO before comparing (`:730-733`) — the classic silent-corruption bug here, explicitly avoided (and repeated in `accept_suggestion`'s overlap math).
- `completionGate` loads the edge index first and the full context only when predecessors exist — the expensive path is at least gated.
- `habit.check_off`/`sprint.add_node` use partial-index arbiters in `onConflictDoNothing` (`WHERE deleted_at IS NULL`) — §7.7 soft-delete-recreate works at the write site, not just in the schema.

## Matrix updates applied (sequential mode)

- V2 → ✅ (S4: `command_log.id` = client id in-txn; response echoes `created_by_command_id`)
- V3 → ✅ (S4: causal gate exact; F7 notes the cross-batch device floor as hardening)
- V4 → ✅ (S4: strip-before-parse + strict schemas + server-assigned `sys`/`born`)
- R17 → ✅ (same)
- R6 → server half ✅ (no generic endpoint; named envelopes only) — client half stays 🔎 S7
- R12 → server half ✅ (durable linked review item per rejection) — UI surfacing stays 🔎 S9
- R16 → ⚠️ (S4-F1 floor bypass on absent version)
- R9 → ⚠️ (S4-F3: command-level effects channel empty; row-level provenance intact)
- R18 → read side ✅ (dedup honored ≥ horizon by design); purge guarantee stays 🔎 S5

## Handoff items

1. **S5:** retention purge must keep dedup/command_log rows ≥ MAX_OFFLINE_HORIZON (R18 write side); does `aggregates-recompute` sum per-entry hours (S3-F2 server half); backstop's drift items + `rule_version`/`template_version` stamping (S3-F4); import table-name allowlist (carried).
2. **S6:** powersync.yaml audience/kid must match the JWT the API signs (no `iss` expected); indexes for the dispatcher's hot lookups (`command_log.id` PK ✓ by definition; `command_field_versions` (table,row,field) — verify a unique index backs the `onConflictDoUpdate` target; review items by (user,status)).
3. **S7:** client `execute()` must run invariants pre-flight (S3-F3); how the client predicts `diagram_layouts` ids (S4-F9); upload watcher must send batches in HLC order and never parallel (F7's mitigation).
4. **S10:** prod compose must map `PS_JWT_*` → the API's `POWERSYNC_JWT_*` (F4); dev-secret fail-fast; body limits + auth rate limiting in the threat pass.

**Next:** Session 5 — server jobs (`apps/server/src/jobs/*`) against §12, §10.2 (V6), §7.4/§7.5, V11/R18, R19/V10, §13.1.
