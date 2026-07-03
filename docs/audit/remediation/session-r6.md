# Remediation Session R6 — Upload robustness + versions end-to-end

Branch `r06-upload-versions` (cut from `remediation` after R1–R4 merged). Executed 2026-07-02. Wave 2 (parallel with R5; disjoint files).

**Findings addressed:** **S7-F2 (High)**, S7-F3 + S4-F1 (coupled, D7-ordered), S7-F6, S7-F8, S7-F9, S4-F8 + the 150-pending and absent-version regression tests.

## Commit series (D7: client emits versions BEFORE the server rejects version-less)

### 1 · `377060c` — client commands carry the version axes end-to-end (S7-F3)
- `client_commands` (local-only) gains `command_version`/`schema_version`/`client_version`/`depends_on` columns.
- `overlay-store.enqueue(command, effects, dependsOn?)` stamps the version axes via core `defaultCommandMeta()` at enqueue (the minting version) + persists `depends_on`; new `PendingCommand` type; `pendingCommands()` returns it.
- `upload-commands` envelope body carries `command_version`/`schema_version` always, `client_version`/`depends_on` when set (strict envelope).
- **R5 handshake (§R5.5):** the `enqueue` third arg `dependsOn` is the interface R5 derives into. R5 has NOT merged yet, so `execute.ts` still calls `enqueue(command, effects)` (2 args) — the optional param keeps it compiling; R5 lands the derivation + passes the 3rd arg. Column + envelope field are ready.

### 2 · `6165586` — upload-queue robustness
- **Chunking (S7-F2, High):** `uploadClientCommands` splits the pending queue into sequential ≤100-command batches (HLC order preserved), so a >100 offline backlog no longer 400s the whole envelope and wedges the queue forever. **A 4xx (except 429) surfaces as `UploadClientError`** and the driver stops the timer-retry (logged loudly, `blockedByClientError`) — a fresh local write clears the block; 429/5xx/network stay transient (throw → retry).
- **Reconcile-on-arrival (S7-F6):** `markApplied()` replaces `reconcileApplied()` — the overlay is KEPT on ack; `reconcileConfirmed()` drops it only once the canonical row arrives (present + `last_modified_by_command_id === id`, or gone/tombstoned for a delete; falls back to presence for tables without the provenance column). No revert-flicker between ack and down-sync. `reconcileConfirmed` runs at the top of every drain (so applied commands reconcile even after the queue empties).
- **HLC persistence (S7-F8):** `createHlc(deviceId, storage?, seedHlc?)` seeds from the persisted last tick + an optional caller high-water and persists every tick, so a wall-clock regression across a restart can't mint an HLC below an already-applied one. Guarded: no-op on RN (no `localStorage`) unless a storage is passed.
- **Lifecycle (S7-F9):** `startCommandUpload`'s `stop()` disposes the `db.watch` via an `AbortSignal`; `reconcileConfirmed` prunes `rejected` rows older than 30 days.

### 3 · `d24a228` — server enforces the floor + poison-batch isolation
- **Floor (S4-F1):** absent `schema_version` is now treated as below-floor (0) → `E_CLIENT_TOO_OLD` + `schema_version_block` item, instead of silently bypassing §7.11. `command_log` records absent as 0.
- **Poison batch (S4-F8):** a command that throws a *data/logic* error is rejected `E_INTERNAL` + a linked review item (its txn already rolled back — no partial effects) so one bad command can't 500 the whole upload and wedge the device queue. *Transient* infra (pg `08*`/`40001`/`40P01`/`57P01`/`53*`, node `ECONN*`) still rethrows → 500 → client retries. Client sees only a generic reason (no internal-error leak).

## Tests
- **ui (82, +4 net):** 150-pending → 2 batches → all applied (S7-F2); a 4xx → `UploadClientError`, still queued; a persistent 4xx logged loudly + does not spin the timer (connector); the "applied" test rewritten to the reconcile-on-arrival contract (overlay kept until canonical arrival, then `reconcileConfirmed` clears it); HLC persist-survives-restart with a regressed wall clock (S7-F8). Mocks in overlay-spike/connector/commands updated to `markApplied`/`reconcileConfirmed`.
- **server (123, convergence 16):** new scenario 15 — a version-less envelope is rejected `client_too_old` (+ a `schema_version_block` item), and the same command WITH a floor-satisfying version applies. Every test-client command builder across the 11 integration files (+ inline literals in m0-spike/m5-causal) now emits `schema_version`, mirroring a real R6 client.

## Red → green evidence
- **S7-F2 (150-pending):** the chunking test asserts exactly `[100, 50]` batch sizes; before chunking the single 150-command request would 400 on the server's `max(100)` envelope cap.
- **S4-F1 (scenario 15):** the assertion `rejected E_CLIENT_TOO_OLD` for a version-less command encodes post-fix behavior — pre-fix (the `!== undefined` guard) that command applied. (Not re-run red here since the fix landed with the test; the guard removal is the one-line diff.)

## Gate evidence (compose PG up + `PRISMS_DB_TEST_URL` set)
- `pnpm --filter @prisms/ui test` → **82 passed**; typecheck + lint clean.
- `pnpm --filter @prisms/server test` → 14 files, **123 passed** (convergence **16/16**), integration suites RAN.
- `pnpm turbo lint typecheck test` → **21/21**. Core untouched by R6 → coverage unchanged from R2 (90.49/93.4/93.58 ≥90).

## Deviations / notes
- **Additive index/type exports:** `packages/ui/src/index.ts` re-exports `PendingCommand`, `UploadClientError`, `MAX_UPLOAD_BATCH` (additive). 10 server integration test files + their local `Cmd`/`Envelope` types gained an optional `schema_version` and a `schema_version: 1` default in their command builders — the D7-mandated "test clients are clients too" consequence of the floor. m5-causal's floor test still passes `schema_version: 0` explicitly (its `mk` default is overridden by `...extra`).
- **429 is transient, not a 4xx-poison:** rate-limit responses retry like 5xx (the 4xx-poison path excludes 429) — caught by the existing "network/429" ui test.
- **Reconcile-on-arrival for non-provenance tables:** tables whose client schema omits `last_modified_by_command_id` (edges, time_entries, …) confirm by presence (insert) / absence (delete). Documented per the playbook timebox; the exact-command-id confirmation applies to `nodes`/`schedule_blocks` (where most edits land).
- **S4-F8 tradeoff:** a *poison* command now rejects (E_INTERNAL) rather than 500ing; the retryable-error classifier keeps transient infra retrying. No dedicated poison integration test (constructing a deterministic non-unique, non-retryable mid-command throw is contrived); the txn-rollback guarantee + the classifier are the fix, and every rejection path is already review-item-covered.

## Handoffs
- **R5:** consume `enqueue(command, effects, dependsOn)` — derive `depends_on` at enqueue and pass it (column + envelope field are wired here). Mirror R2's acceptance-safe evaluator in the client invariant pre-flight (unchanged from R2's note).
- **R10 (SELF_HOSTING, per D7):** document that installed clients must update **before/with** the server for a floor raise — the server rejects version-less/below-floor commands `client_too_old` with a review item. Also: the S4-F8 poison→E_INTERNAL behavior and the 4xx-diagnostics hook (a future diagnostics screen can read the loud-logged `UploadClientError`).

## Fence compliance
Owned: `packages/ui/src/powersync/{overlay-store,upload-commands,connector,client-runtime,schema}.ts` + ui tests. Shared (my regions only): `dispatcher.ts` (floor gate + `logResult`/txn version defaults + the catch + `isRetryableError` helper), harness (append scenario 15 + Device/seed version defaults), `packages/ui/src/index.ts` (additive re-exports). Envelope schema (`core/commands/envelope.ts`) already accepted the version/`depends_on` fields — no core edit needed. **Forbidden untouched:** `execute.ts`/`commands.ts`/`effects.ts` (R5), `data-provider.tsx`/`hooks.ts` (R7/R3/R9).
