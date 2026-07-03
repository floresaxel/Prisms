# Audit Session 8 — Client Read Path, Shared UI, Portability Client, Adapter Ports

Audited at commit `020d779` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-02.

**Scope examined:** `packages/ui/src/powersync/data-provider.tsx` (full), `hooks.ts` (Fix-C machinery `:1-260` + sort call sites `:474,:791`; the ~30 domain hooks not line-audited individually), `portability/crypto.ts` (full), `provenance.ts` (full), `adapters/secure-storage.ts` (full). **Inventory-only:** `adapters/db-encryption.ts`, `portability/export-import.ts` (S2 audited its core manifest schema; M13 tests cover round-trip), `worklist-grouping.ts`, `components/*` (List/Skeleton contract trusted via M12 tests).

**Verdict:** Fix A and Fix C are implemented with unusual care — the provider is exactly the §7.14 shape (9+1 subscriptions, one memo chain, `hasSynced`-grounded hydration with the offline-populated-reload disjunct), and the SWR layer gets the subtle things right (undefined-vs-empty, produce-marking after commit, shared SQL constants to prevent hydration-key drift). The findings: the full-rebuild-per-change cost at the exact seam the StatusIndex was built for, an uncleared cross-account cache, a mis-cited KDF strength — plus one **correction that downgrades S6-F3**.

---

## Findings

### S8-F1 · Medium — every data change rebuilds the entire FactContext (S2-F3's client half, quantified at its designated seam)

**Evidence:** `data-provider.tsx:134-169` — any change to any of the 9 base tables *or the overlay* produces a new `rows` object, which re-runs `buildFactContext` over **all** rows, including a full mapper pass (`toNode` etc. over every row). Since every `execute()` writes `overlay_effects`, **every optimistic write triggers a full rebuild**. At the spec's 100k scale that is ~65 ms (S2's measured figure) of main-thread work per keystroke-level command, plus the mapper allocation churn. The file's own header designates this as the `StatusIndex` seam ("a later §7.12 StatusIndex would live here").

**Failure mode:** UI jank scaling linearly with account size on every interaction — the precise cliff V7 exists to remove, now confirmed at both tiers (server: S4-F2; client: here).

**Suggested change:** wire the incremental path at this seam: maintain `StatusIndex` (and an incrementally-updated TreeIndex/FactContext view) fed by the same overlay/sync deltas, replacing rebuild-per-change with `apply()` (~0.02 ms measured). This is the audit's most-repeated root finding; the provider is where the fix lives. (Fixing S2-F4's fan-out gaps first is a prerequisite.)

### S8-F2 · Medium — `ROWS_CACHE`/`PRODUCED` are never cleared on logout or account switch

**Evidence:** `hooks.ts:120-123` — both are module-scoped; the only reset is `__resetReadCacheForTests` (`:151-156`, "never called by app code"); the design comment says "a full reload clears it".

**Failure mode:** an SPA logout → different-account login *without* a full page reload leaves the previous user's merged rows cached under identical keys: the new user's first render of any warm screen-local read serves the **previous account's data** synchronously (until the fresh query overwrites), and `PRODUCED` short-circuits the skeleton that would otherwise mask it. Privacy-adjacent on shared devices.

**Suggested change:** clear both (and bump `producedVersion`) when the authenticated session changes — the `PrismsDataProvider` unmount/remount or the PowerSync db identity change is the natural hook; alternatively include a user/db token in `keyOf`. **Handoff (S9):** check whether web signout currently forces a reload (if it provably does, downgrade to Low and document the invariant).

### S8-F3 · Low — PBKDF2 iteration count mis-cites its own standard; decrypt honors uncapped file-supplied iterations

**Evidence:** `crypto.ts:16` — `PBKDF2_ITERATIONS = 210_000; // OWASP 2023 PBKDF2-SHA256 floor`. 210k is OWASP's PBKDF2-**SHA-512** figure; the SHA-256 floor is **600k**. And `decryptExport:106` derives with `env.iterations` from the file, uncapped — a crafted envelope with an absurd count hangs the UI mid-derivation (no confidentiality impact; pure DoS nuisance).

**Suggested change:** raise to 600k for new exports (the envelope already stores `iterations`, and decrypt already honors it — old files keep working; the migration design is genuinely good) or switch the KDF hash to SHA-512 and keep 210k; cap accepted `iterations` on decrypt (e.g. ≤ 10 M). Everything else verified sound: AES-256-GCM, random 16-byte salt + 12-byte IV per export, wrong-passphrase = clean auth failure, versioned envelope with explicit newer-version error (R11), chunked base64, empty-passphrase rejected.

### S8-F4 · Correction — S6-F3 downgraded (Medium → Low): UI sibling order IS deterministic and convergent, via an id tiebreak

**Evidence:** `hooks.ts:474` and `:791` sort by `(sort_order, id)` — a **total, deterministic order**. Two devices with the same converged rows therefore display the **same** order, including after a fractional-index collision. S6-F3's failure scenario ("two devices can render different orders forever") was wrong and is withdrawn.

**What remains (Low):** the tiebreak is `id`, not the spec's `hlc` (§7.10a), so the collision order differs from the canonical `(sort_order, hlc)` order — consistently everywhere, but a spec-letter deviation; and the `hlc` column is still absent from the client schema, so the spec'd key *couldn't* be used without S6-F3's schema addition. Resolve by either amending §7.10a to bless the id tiebreak (server-side `compareSortKey` would then also need aligning for true letter-consistency) or adding the client `hlc` column and switching both call sites to `compareSortKey`. Decide once; the current state is safe.

### S8-F5 · Info — the provenance panel's version line can never render (S3-F4's display site)

**Evidence:** `provenance.ts:57-63` reads `rule_version`/`template_version` from `source_detail` and renders "Rule vX · template vY" — values no code path ever stamps (S3-F4, confirmed at three sites now). Fixing S3-F4 lights this up with zero UI work.

### S8-F6 · Info — minor read-path notes (bundle)

- Optimistically soft-deleted nodes use op `delete`, so they vanish from `rows.nodes` entirely — Dashboard's tombstone-*inclusive* series transiently under-counts until the tombstoned row syncs back (consistent with the S7-F7 world; self-heals).
- `ROWS_CACHE` interplay with S7-F6 confirmed: the cache is overwritten on every produced result, so the ack-before-sync-down revert-flicker propagates through it — neither masked nor amplified.
- `ROWS_CACHE` is unbounded but its key space is the set of distinct screen-local queries (small, mostly static SQL constants) — growth is bounded in practice.
- Each screen-local read opens exactly two subscriptions (replica + table-filtered overlay) — by design, pinned by the read-layer test.

---

## Resolved handoffs

| Handoff | Resolution |
|---|---|
| UI sibling-sort call sites (S6-F3) | **Resolved with correction — F4** (downgrade to Low; order is convergent via id tiebreak). |
| ROWS_CACHE ↔ S7-F6 flicker interplay | **Resolved** — cache follows live results; flicker visible, not amplified (F6 bundle). |
| StatusIndex client seam + rebuild cadence (S2-F3) | **Confirmed and quantified — F1**; the provider is the designated seam. |
| R9 client half (S3) | **PASS** — `explainProvenance` covers every `source_kind`, legacy + unknown → "origin unknown" with honest detail text; consistent with S7's optimistic `source_kind='user'` prediction; blank-version line noted (F5). |

## Compliance checklist results

| Check (playbook §S8) | Result |
|---|---|
| Fix A (§7.14): one subscription set per session; FactContext built once; not unmounted by navigation; no now-tick rebuild | **PASS** — 9 base + 1 overlay `useQuery`; single memo chain; mounted above the router (App.tsx mounting re-checked in S9); now-tick independence pinned by `data-provider.test.ts`; rebuild-per-data-change cost → F1 |
| `isHydrated` grounded in `hasSynced` | **PASS** — `firstResult && (hasSynced || anyRow)`; the `anyRow` disjunct correctly prevents a stuck skeleton on offline populated reload |
| Fix C (§7.15): `{data,isLoading,isFetching}`; module ROWS_CACHE; warm synchronous revisit | **PASS** — `replica === undefined` (loading) vs `[]` (confirmed empty) distinguished; cache written on every produced merge; `isLoading = !produced && !cached` |
| Cache lifecycle: eviction/logout | **FAIL on logout → F2**; growth bounded in practice (F6) |
| Hydration additive; PRODUCED via `useSyncExternalStore`, no second subscription | **PASS** — reactive version bump after commit (`useEffect`), shared SQL constants prevent key drift between data hook and `…Hydrated` companion |
| Empty-state gating contract | **PASS (trusted)** — screens gate on `isHydrated && length === 0`; component internals covered by M12's loading-aware tests; screen sweep → S9 |
| `explainProvenance` all source_kinds; legacy → origin unknown | **PASS** (F5 note) |
| Crypto: AES-256-GCM, PBKDF2 params, salt/IV, auth-fail, versioned envelope, no crypto in core | **PASS with F3** (iterations below the cited floor; uncapped decrypt iterations) |
| export-import version-gated, DOM-free; import HLC floor | **PASS** — core manifest strict schema + `isSupportedExportVersion` (S2); floor verified in S7 (`client-runtime.ts`); file itself inventory-only this session |
| Adapter ports provider-neutral; web degrades honestly; test fakes exist (§13.3) | **PASS** — `SecureStorage` port with documented web limitation (real auth = HTTP-only cookie, never in JS) + memory fake; `db-encryption.ts` inventory-only (installed impls → S9) |

## Positive observations

- The hydration design is the most subtle piece of UI state in the repo and it is *right*: session-level `hasSynced ∨ anyRow` composed with per-read `PRODUCED`, reactive via one external store instead of N subscriptions, with the SQL-constant discipline called out in a comment explaining exactly what drift it prevents.
- `mergeFor` returns the replica array by reference when a table has no overlay effects — the no-write fast path allocates nothing.
- The encrypted-envelope design (self-describing kdf/cipher/iterations, decrypt honoring stored parameters) means the F3 iteration bump is a two-line change with zero migration code — the versioning discipline paying for itself.
- The web secure-storage impl *documents its own weakness* rather than pretending: localStorage is labeled non-hardware-backed and the actual session secret is architecturally kept out of JS reach.

## Matrix updates applied (sequential mode)

- R2 → ✅ (S8: all reads local SQLite via provider/SWR; hydration prevents network-wait UX; app-level sweep → S9)
- R9 → UI half ✅ (S8: explainProvenance complete); row stays ⚠️ for S4-F3 (`command_log.effects` empty)
- R13 → web half ✅ (port + honest degradation + fake); installed impls → S9
- V9 → note corrected (S6-F3 downgraded: UI order deterministic via id tiebreak; spec-letter deviation only — S8-F4)

## Handoff items

1. **S9:** does web signout force a full reload? (F2's severity hinges on it); mobile encrypted-export path — Expo/Hermes has no `crypto.subtle` without polyfill; if `src/portability.ts` calls `encryptExport` on-device, the M14 encrypted-by-default flow may **throw at runtime** on mobile (the M14 caveat "runtime never verified" bites exactly here); screen-level empty-state sweep; App.tsx provider-above-router mounting.
2. **S10:** F1 belongs to the consolidated StatusIndex-wiring remediation (S2-F3 + S4-F2 + S8-F1 = one workstream); crypto F3 into the security roll-up.

**Next:** Session 9 — apps (web screens, mobile, desktop) incl. S1-F6 (React override vs Expo) and S1-F7 (PowerSync port default).
