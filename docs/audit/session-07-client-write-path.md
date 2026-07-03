# Audit Session 7 — Client Write Path: Two-Layer Store, Effects, Upload

Audited at commit `50d0c4b` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-02.

**Scope examined:** `packages/ui/src/powersync/{execute,overlay-store,upload-commands,connector,client-runtime}.ts` in full; `effects.ts` (header + ~10 sampled verbs incl. the delegation cases); `commands.ts` (targeted: checkOff, softDelete, acceptSuggestion, layout writers, promote/create). **Not line-audited:** the full 57-verb `effects.ts` sweep (M15's coverage test proves every `CommandName` has a writer; ~10 verbs parity-sampled), `buildAcceptSuggestionEffects` internals (merged-state call site verified; M9 tests cover the txn mirror), `rows.ts`/`streams.ts` (S8/S6 scope).

**Verdict:** the two-layer core contract is honored — atomic enqueue (R15), write-time id+HLC minting (V2), the loud guard (DoF 3), event-driven sequential upload, and a genuinely correct import-HLC-floor design. But this session found the audit's third and fourth High findings: **offline automation spawning does not exist** (R4 is a hard requirement), and **a device with >100 queued commands wedges its upload queue permanently and silently**. Three §7.2d steps are skipped outright (invariants, `depends_on`, reconcile-on-canonical-arrival), continuing the built-but-not-wired pattern.

---

## Findings

### S7-F1 · High — offline automation spawning does not exist (R4, §10.1 client half)

**Evidence:** zero references to `runAutomations`/`spawnedTaskId`/the rules engine anywhere in `packages/ui` or the apps (repo grep). §10.1: automation rules "execute synchronously inside the same local SQLite transaction (overlay) as the triggering command, and are re-applied authoritatively server-side." R4: "Follow-up task spawning … must work offline." The server halves exist (dispatcher in-txn + backstop); the client half was never built.

**Failure mode:** offline user completes "Sand the deck," which has a rule "spawn 'Apply stain' +2d." Nothing appears — not in the worklist, not in the agenda — until reconnect, when the server's fixpoint output syncs down. The user plans the rest of the day against a list that's missing the work their own automation should have added. No divergence (server is authoritative) — a pure functional hole in a hard requirement.

**Suggested change:** in `execute()`, after building the verb's effects, when the verb implies `task_created`/`task_completed`, run core's `runAutomations` against the merged fact set and append the spawn effects (insert specs) to the overlay. The system was *designed* for this: UUIDv5 spawn ids mean the server's authoritative rows reconcile the optimistic ones byte-identically, and `checkNodeCreate` gives the same I1/I3 spawn validation the server applies. Needs the same merged `FactRows` loading as F4 — build them together.

### S7-F2 · High — more than 100 pending commands permanently and silently wedge the upload queue

**Evidence:** `uploadClientCommands` sends **all** pending commands in one request (`upload-commands.ts:50-63`, no chunking); the server's `uploadRequestSchema` caps `commands` at 100 (`core/commands/envelope.ts:36`) → 400 `parse_error` → `!res.ok` throws (`:65`) → `startCommandUpload`'s catch swallows it indistinguishably from a network error (`connector.ts:104-105`) → retried every 15 s, forever.

**Failure mode:** a weekend offline with 101+ edits (a busy afternoon of check-offs, timer flows, and reorders reaches this easily) → on reconnect, every upload attempt 400s; nothing ever syncs again; no review item, no banner, no console distinction from being offline. The user's device is silently forked from the server until someone debugs it.

**Suggested change:** chunk `pendingCommands()` into sequential ≤100 batches (HLC order preserved; the in-flight guard already serializes). Separately, make the catch distinguish 4xx from network: a 4xx response should surface loudly (it will never succeed by retrying). Add a regression test: 150 pending → all applied.

### S7-F3 · Medium — envelopes never carry `command_version`/`schema_version`/`client_version`: §7.11/R16 enforcement is vacuous end-to-end (compounds S4-F1)

**Evidence:** the upload body is `{ id, name, hlc, payload }` only (`upload-commands.ts:61`); `ClientCommand` and the `client_commands` table store no versions; core's `defaultCommandMeta` (built in M1 for exactly this) has no ui consumer — another built-but-unwired primitive.

**Failure mode:** combined with S4-F1 (server skips the floor when `schema_version` is absent): today every client omits it and every command bypasses the floor. Worse, the fixes are **coupled**: fixing S4-F1 alone (absent → below-floor) would instantly reject every current client's every command. The remediation must land client-first (send `defaultCommandMeta()` values), then server-side (absent → reject).

**Suggested change:** spread `defaultCommandMeta()` into the envelope at upload (or persist versions at enqueue time — better, since it captures the version that *minted* the command); then apply the S4-F1 server fix. Sequence this explicitly in the remediation plan.

### S7-F4 · Medium — §7.2d step 2 skipped: no invariant pre-flight against merged state (S3-F3 confirmed at the integration point)

**Evidence:** `execute.ts:67-101` — strip → Zod parse → effects → enqueue. No FactContext, no `check*` call (repo-wide grep confirms zero ui references to any invariant checker).

**Failure mode:** concretely with clock-in: a second clock-in while a timer runs optimistically inserts a second open entry — the display switches to the new timer (latest-started wins the projection) — then the server rejects `E_TIMER_ALREADY_RUNNING` and it snaps back. Offline, the invalid state persists for the whole offline period. The spec's design gives an instant local rejection instead.

**Suggested change:** build merged `FactRows` (the data-provider already holds them — S8 seam), run the verb's checker before enqueue, and surface failures as immediate command errors. Shares its data dependency with F1.

### S7-F5 · Medium — `depends_on` is never derived or sent (§7.2d step 4, §7.2e client half)

**Evidence:** no `depends_on` anywhere in the client write path; `ClientCommand` (core) and the local table lack the field; envelopes omit it, so the server's causal gate iterates an empty list for every real command.

**Failure mode:** the happy path is covered by strictly-sequential HLC-ordered upload (single-flight confirmed). The degradation: when a parent command is rejected (e.g., `node.create` fails an invariant), the dependent `edge.create` is rejected as a generic `E_NOT_FOUND` instead of `dependency_rejected` with a linked cascade — V3's carefully-built server semantics (and its review-item UX) never fire for real clients. The convergence harness's dependency-cascade scenario constructs `depends_on` by hand, testing a path no client exercises.

**Suggested change:** derive it cheaply at enqueue: any payload row-id that matches a still-pending command's created row id (the overlay knows this — `overlay_effects` op='insert' row_ids) becomes a dependency. Store and send it.

### S7-F6 · Medium — the overlay is dropped on ack, not on canonical-row arrival (§7.2d)

**Evidence:** `upload-commands.ts:81` calls `store.reconcileApplied` immediately on the `applied`/`noop` response; `reconcileApplied` deletes the effects and the command row outright (`overlay-store.ts:132-137`). §7.2d specifies: mark applied, **wait** for the canonical rows via sync, *then* delete the effects (short-lived applied tombstone).

**Failure mode:** between the ack and PowerSync's download of the changed row (replication + download latency — typically sub-second, but seconds on slow links or under batch load), the merged read serves the **old** replica value: the user's rename/check-off visibly reverts, then re-applies. Under M12's SWR caches this flicker can also be *cached* briefly (S8 to check the interplay).

**Suggested change:** implement the spec's tombstone: on ack set `status='applied'` (keep effects); a reconciler (the data-provider's sync-batch hook is the natural seam) deletes effects whose canonical row now exists with `last_modified_by_command_id === command.id` (the V2 identity makes this exact). Or accept-and-document as a UX tradeoff — but decide.

### S7-F7 · Medium — offline soft-delete leaves the subtree visible: no client-side I10 closure

**Evidence:** `commands.ts:49-53` — "optimistically remove the named node; the server cascades the §I10 closure" — contradicting `effects.ts:123`'s claim that "the live writer adds the §I10 descendant closure." The `extraEffects` mechanism built for this (`execute.ts:52`) has no caller; core's `softDeleteClosure` (used by the dispatcher) has no ui consumer.

**Failure mode:** offline, delete a project: the project vanishes but its milestones/tasks stay in the worklist, kanban, and agenda (flat views don't tree-walk) for the whole offline period, then vanish on reconnect. Confusing exactly when the user can't ask the server.

**Suggested change:** compute `softDeleteClosure` over the merged tree and pass `del` effects via `extraEffects` — the designed, unused mechanism. Fix the stale comment either way.

### S7-F8 · Low-Medium — the HLC clock doesn't persist its last tick across restarts

**Evidence:** `client-runtime.ts:63-71` — `prev` lives in the closure; only the *import floor* is persisted (`HLC_FLOOR_KEY`). After a restart, the first tick is `max(0, Date.now())`.

**Failure mode:** if the wall clock moves backwards across a restart (NTP correction, manual change), new commands mint HLCs *below* still-pending or already-applied ones from the previous session — same-device HLC order breaks silently: the post-restart edit loses LWW to the pre-restart one. Rare, silent, and exactly what §7.9a's monotonicity mandate exists to prevent (Annex A2 is the related unadopted guard).

**Suggested change:** at startup, seed `prev` from `max(persisted last-tick, max(client_commands.hlc), import floor)` — the pending queue is already a durable HLC high-water mark; one query.

### S7-F9 · Low — lifecycle leaks: the watch outlives `stop()`, rejected commands accumulate

**Evidence:** `startCommandUpload`'s stop function clears only the timer (`connector.ts:113`) — the `db.watch` keeps firing `drain()` (uploads continue after logout until the db closes); `rollbackRejected` keeps the `client_commands` row forever (by design, for reject-code display) with no pruning path.

**Suggested change:** capture and dispose the watch subscription (the SDK returns one via the AbortSignal/dispose API); prune rejected rows older than e.g. 30 days during reconcile passes.

---

## Resolved handoffs

| Handoff | Resolution |
|---|---|
| Does the client run the rules engine in its overlay? (S5, R4) | **NO — F1 (High).** |
| Client invariant pre-flight (S3-F3) | **CONFIRMED ABSENT — F4.** |
| Does anything read `command_log`/`command_results` client-side? (S6-F2) | **NO** — schema comment explicit, grep clean. The stream can be dropped outright. |
| Client `diagram_layouts` id prediction (S4-F9) | **RESOLVED, benign** — existing layout: optimistic update on the known id; first placement: deliberately no overlay (server mints the id; flowchart masks with local drag state; documented at `commands.ts:259-263`). |
| Upload strictly sequential, HLC-ordered (S4-F7) | **PASS** — `pendingCommands()` ORDER BY hlc; single fetch; `inFlight` guard; server idempotency covers residual races. |
| How the simplified `client_commands` produces envelopes (S6) | Stored `id/name/hlc/payload` + `deviceId` param at upload; **versions missing → F3**; `depends_on` missing → F5. |

## Compliance checklist results

| Check (playbook §S7) | Result |
|---|---|
| `executeCommand`: one generic writer; envelope minted at write time (V2); atomic queue write (R15) | **PASS** — strip→parse→mint UUIDv7+HLC→`enqueue` in one SQLite `writeTransaction`; crash-consistency holds (the A4 concern is closed by the txn) |
| §7.2d step 2 (invariants vs merged state) | **FAIL → F4** |
| §7.2d step 4 (`depends_on`) | **FAIL → F5** |
| Effects coverage + server parity | **PASS (sampled)** — M15 coverage test proves every verb has a writer; sampled verbs match server semantics in the loose representation (JSON-as-text, bool-as-0/1, minimal-field `clean()`); `accept_suggestion` reads **merged** state and mirrors the §7.5 txn via `buildAcceptSuggestionEffects` ✓; delegation comments drifted (F7) |
| Optimistic provenance prediction (V2) | **PASS** — inserts predict `source_kind='user'` + `user_id`; server reconciles authoritatively; `created_by_command_id` equality holds end-to-end (S4 verified the server half) |
| Overlay disposable; rollback = drop + review item via sync (V1) | **PASS** — `rollbackRejected` deletes effects, marks the command, writes no review item (server-owned, syncs down) ✓; reconcile timing → F6 |
| Loud guard: no CRUD upload path (DoF 3) | **PASS** — non-empty batch throws with offender detail; empty batch completes; M15 retired the CRUD bridge |
| Upload: HLC order, sequential, retry/backoff, response contract | **PARTIAL** — order/sequencing/idempotent-retry ✓; `applied|noop`→reconcile, `rejected`→rollback+onReject ✓; missing-result→stay pending ✓; **batch cap unhandled → F2**; `client_too_old` handled as a generic rejection (review item + banner path — acceptable per §7.11) |
| Queue survives restart | **PASS** — local-only SQLite tables; initial `drain()` on start |
| Tier 2 lazy subscribe graceful | Deferred to S9 (mobile caveat) — `streams.ts` not re-audited here |
| R4 offline verbs | **PARTIAL** — clock-in/out ✓, agenda edits ✓, suggestion accept/reject ✓ (merged-state), dependency unblocking ✓ (derived status); **spawning ✗ → F1**; soft-delete degraded → F7 |

## Positive observations

- The import-HLC-floor design (`client-runtime.ts:10-43`) is exactly right: a shared module floor that dominates even an already-constructed clock, persisted and re-observed at startup — R20's client half verified (closing the S5 matrix note).
- `enqueue`'s single-transaction guarantee quietly closes the crash-recovery gap that Annex A4 worries about at the write side.
- The watcher is event-driven (watch on the pending count) with an initial drain and a retry timer — not a poll loop; the in-flight guard makes concurrent-trigger behavior trivially safe.
- The effects builder's representation discipline (JSON-as-text, 0/1 booleans, `clean()` dropping only `undefined`) shows real understanding of PowerSync's loose storage — the classic merged-read type-mismatch bugs are pre-empted.

## Matrix updates applied (sequential mode)

- V1 → ✅ (rollback-drops-overlay verified; reconcile-timing deviation noted — S7-F6)
- V2 → ✅ end-to-end (S4 server half + S7 client half: write-time minting, verbatim upload)
- R6 → ✅ end-to-end (S4 server half + S7 loud guard / envelope-only upload)
- R15 → ✅ (two-layer store verified; F6 note)
- R4 → ⚠️ (**S7-F1 High**: spawning absent offline; soft-delete closure degraded — S7-F7)
- R16 → note strengthened (S7-F3: client never sends versions; compounds S4-F1; coordinated fix required)
- R20 → ✅ client half (import floor verified) — full row now ✅

## Handoff items

1. **S8:** the data-provider's merged `FactRows` are the natural seam for F1+F4 (spawn + invariant pre-flight) and for F6's canonical-arrival reconciler; check ROWS_CACHE interplay with the F6 flicker window.
2. **S9:** mobile/desktop `getDeviceId` routing (secure storage on installed targets, R13); Flowchart drag-state masking of first-placement lag (F-resolved behavior worth an e2e note).
3. **S10:** add F2's 150-pending regression to the gate list; the remediation plan must sequence F3 client-first then S4-F1 server-side.

**Next:** Session 8 — client read path & shared UI (`data-provider.tsx`, `hooks.ts`, portability client, adapter ports) against §7.14/§7.15 (Fixes A/C), §13.1–§13.3.
