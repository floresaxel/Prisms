# M0 — Risk-Reduction Spike: Go / No-Go

**Verdict: GO.** The load-bearing v1.3 two-layer contracts are proven end-to-end
on `node.rename`. PowerSync on the existing stack can carry the explicit
`client_commands` upload and a tiered, JWT-scoped Sync Streams config. The
`connector.ts` `getCrudBatch` path can be replaced by a `client_commands`
reader (M8). No blocking feasibility risk surfaced.

This spike is **additive**: the v1.0 CRUD-patch upload path is untouched, so the
existing behavioral surface stays intact. The two-layer path runs alongside it
for `node.rename` only, behind tests.

---

## What was built (the slice)

| Area | File | Role |
| --- | --- | --- |
| core (pure) | `packages/core/src/sync/overlay.ts` | `mergeRow`/`mergeTable`, `stripTrustFields`, `buildRenameEffect`, overlay/command types |
| ui schema | `packages/ui/src/powersync/schema.ts` | local-only `client_commands` / `overlay_effects` / `sync_review_items`; `appSchema` (21 synced, unchanged) + `clientSchema` (synced + local) |
| ui write | `packages/ui/src/powersync/execute.ts` | `createExecuteCommand.renameNode` — strip trust → validate → mint id+HLC → write overlay in one txn |
| ui store | `packages/ui/src/powersync/overlay-store.ts` | `OverlayStore` repo + `createSqlOverlayStore` (real SQL over a `SqlExecutor`) + `readMergedRows` |
| ui upload | `packages/ui/src/powersync/upload-commands.ts` | `uploadClientCommands` — upload envelopes preserving id+HLC; reconcile applied / rollback rejected + review item |
| db | `packages/db/sync-streams.tier0.yaml` | Tier 0/1 draft (JWT-scoped, no client-widenable params) — non-destructive |
| tests | `packages/core/test/sync/overlay.test.ts` (15), `packages/ui/test/overlay-spike.test.ts` (9), `packages/db/test/sync-streams.test.ts` (4), `apps/server/test/m0-spike.integration.test.ts` (4, gated) | the proofs below |

---

## DoD → evidence

1. **Offline rename shows instantly from the merged read.**
   `executeCommand.renameNode` writes `client_commands` + `overlay_effects` in
   one txn; `readMergedRows` returns replica patched by the pending overlay.
   → `overlay-spike.test.ts › executeCommand › merged read shows the pending rename`.

2. **Reconnect uploads exactly one named envelope carrying the client-minted id
   (no row patch, no upload-time id).**
   `uploadClientCommands` POSTs `{ device_id, commands:[{id,name,hlc,payload}] }`
   reading the **stored** id+HLC — no `newId()` at upload. The overlay tables are
   `localOnly`, so they never enter `getCrudBatch()`.
   → `overlay-spike.test.ts › uploads exactly one named envelope with the client-minted id + hlc`.

3. **`command_log.id == client command id` (V2, end-to-end client→server).**
   The real dispatcher persists the command under the **same** UUIDv7 the client
   minted; the canonical `nodes.title` becomes the optimistic title (the
   reconciliation target).
   → `m0-spike.integration.test.ts › persists command_log.id == the client-minted command id`.

4. **Overlay reconciliation.** On `applied`/`noop` the overlay is dropped; the
   identical canonical row (synced back) carries the change. Before the down-sync
   the merged read shows the replica; after it, the new title.
   → `overlay-spike.test.ts › applied: drops the overlay …`.

5. **Forced rejection removes the overlay and creates a review item bound to the
   command id.** On `rejected` the overlay rolls back (merged read reverts to
   canonical) and a `sync_review_items` row (`item_type='command_rejection'`,
   `command_id = id`) is recorded.
   → `overlay-spike.test.ts › rejected: rolls back the overlay and records a review item`.

6. **JWT scoping blocks cross-user receipt; overlay tables absent from
   `appSchema`.** A foreign user's `node.rename` is rejected `E_OWNERSHIP` and the
   row is untouched. `appSchema` has exactly the 21 synced tables; the three
   overlay tables are `localOnly` and live only in `clientSchema`.
   → `m0-spike.integration.test.ts › rejects a cross-user command`; `overlay-spike.test.ts › schema: overlay tables are local-only and out of appSchema`.

7. **Idempotent replay.** Re-uploading the same command id returns `noop`
   (`original_result: applied`); one `command_log` row.
   → `m0-spike.integration.test.ts › replaying the same command id is an idempotent noop`.

8. **Server backstops trust-stripping.** `node.rename` is a strict catalog
   payload, so a client-supplied `user_id` is rejected `E_PARSE` even if the
   client failed to strip it.
   → `m0-spike.integration.test.ts › rejects a payload carrying a client-supplied trust field`.

---

## Feasibility findings (the go/no-go questions)

- **Local-only tables stay out of the upload batch.** PowerSync `Table(..., {
  localOnly: true })` tables are not synced and never appear in `getCrudBatch()`.
  So the optimistic overlay is structurally incapable of being uploaded as a row
  patch — only the named envelope read from `client_commands` is. ✅
- **The explicit `client_commands` upload preserves identity.** Because the id +
  HLC are minted at write time and uploaded verbatim, `command_log.id` equals the
  client id with no change to the server (it already keys `command_log` by the
  arriving id). ✅ The v1.0 `connector.ts` `newId()`-at-upload (line 61) is the
  one thing M8 must delete; `uploadClientCommands` shows the replacement.
- **`getCrudBatch` → `client_commands` reader is viable (M8).** `uploadClientCommands`
  is a drop-in `uploadData` body: it reads pending commands in HLC order instead
  of draining the CRUD queue, and reconciles per the response contract. The only
  coupling is the response shape `{ results:[{id,result,reject_code,reject_reason}] }`,
  which already exists. ✅
- **Sync Streams tiering is feasible on this stack.** `sync-streams.tier0.yaml`
  validates with the exact PowerSync rules engine (`@powersync/service-sync-rules`),
  is JWT-scoped via `request.user_id()`, and exposes no client-widenable
  parameter. Tier 0 (bootstrap: `nodes`, `user_settings`) maps cleanly onto the
  existing per-user scoping. ✅

---

## Deliberate deferrals (NOT regressions)

- **Provenance `created_by_command_id`** (DoD wording) is an M3 column /
  M5 server-assignment. For `node.rename` (an UPDATE) V2 is proven via
  `command_log.id == client id` + the payload's node id; the literal provenance
  column lands with CREATEs in M3/M5 (legacy rows show "origin unknown").
- **`sync_review_items` is client-local in the spike.** M3 adds the server table;
  M5 creates items server-side on rejection; M4 syncs them down. The spike proves
  the rollback+item *binding* locally.
- **`sync-rules.yaml` is unchanged.** The real Sync Rules → Sync Streams migration
  is M4; touching the production rules now would risk the e2e with no way to
  validate the streams runtime here. The Tier-0 draft is the de-risking artifact.
- **One command only.** `node.rename`. M1 broadens the effect builders and merge
  exceptions; M8 generalizes `executeCommand` to the full catalog and stages the
  CRUD-bridge retirement behind a loud guard.
- **No live app rewiring.** `apps/web` still opens `appSchema` via the CRUD path.
  M8 switches it to `clientSchema` + the overlay path. The spike is test-proven,
  not wired into the running shell (lowest risk for a spike).

---

## Verification status (this machine)

- `pnpm turbo typecheck lint` — green across core, ui, db, server.
- Unit tests — green: core 473 (incl. 15 overlay), ui (incl. 9 overlay-spike),
  db (incl. 4 sync-streams).
- `m0-spike.integration.test.ts` — **4/4 green** against the compose Postgres
  (`localhost:5434`).
- `dispatcher.integration.test.ts` — **23/23 green** (same server-side
  convergence code paths the harness relies on).
- **`convergence.integration.test.ts` could not run locally**: `better-sqlite3@12.10.0`
  has no prebuilt binary for this machine's **Node v26.3.1** (NODE_MODULE_VERSION
  147 vs 141), so `new Database(':memory:')` fails to load. This is a pre-existing
  environment gap — M0 touches neither the harness nor the dispatcher's
  convergence logic — and it runs in CI (Node 24). Re-run locally after a
  `better-sqlite3` rebuild against Node 26, or with a Node 24 toolchain.

---

## Risks carried forward

- **M8 cutover is the real risk** (changes upload **and** rollback semantics).
  Stage `crud-to-command` behind a loud guard; do not delete until M15's coverage
  test passes (every `CommandName` has an `executeCommand` writer).
- **HLC monotonicity across write and upload.** The spike ticks the device HLC at
  write (`createExecuteCommand`) and uploads it verbatim — correct. M8 must keep a
  single per-device HLC source (not the connector's separate `createHlc`), or two
  clocks will diverge.
- **Effect ordering.** `overlay_effects` stores `(hlc, seq)`; the merge sorts on
  it. M1's `(sort_order, hlc)` and `mergeTimeEntries` exceptions extend this.
