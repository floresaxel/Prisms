# Audit Session 9 — Apps: Web, Mobile, Desktop

Audited at commit `159175e` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-02.

**Scope examined:** `apps/web/src/{config,auth,App,powersync}.ts(x)` (targeted), `apps/web/src/screens/Settings.tsx` (portability section), DoF-1 raw-write sweep over all web screens, `apps/web/e2e/` inventory, `apps/mobile/src/{portability,powersync}.ts`, mobile dependency resolution (`pnpm why react`), `apps/desktop/src-tauri/tauri.conf.json`. **Inventory-trust (not line-audited):** the 13 web screens' internals and mobile screens (covered by the m9/m10/v14/dod e2e suites and M-session unit tests), `apps/mobile/src/secure-storage.ts` (expo-secure-store dependency present; M14 port contract), Review screen's 9-item-type rendering (M10 test). **Standing caveat inherited from M14: mobile (Expo) and desktop (Tauri) have never been runtime-verified — several findings below are exactly where that caveat bites.**

**Verdict:** the web app is in good shape — no raw writes anywhere in screens (DoF 1 client sweep clean), the encrypted-by-default installed-export UX is implemented to the letter, and the e2e inventory matches CI's claims. The session's headline is an account-boundary hole on shared devices (no `disconnectAndClear`, fixed db filename, pending commands crossing accounts), and both S1 platform risks resolve **against** the current setup: the React override is a confirmed unsupported pairing with a clear root cause, and mobile's only export path calls a WebCrypto API its runtime doesn't have.

---

## Findings

### S9-F1 · High — logout neither clears the local database nor the pending queue: cross-account replica exposure and command cross-posting

**Evidence:** the PowerSync database filename is fixed and account-agnostic (`apps/web/src/powersync.ts:10` — `prisms.db`; `apps/mobile/src/powersync.ts:19` — `prisms.sqlite`); `disconnectAndClear` appears nowhere in the repo; signout is SPA-internal with no reload (`App.tsx:184-188` — `signOut()` + drop the cached user + `setUser(null)`); the only `db.disconnect()` is an unmount cleanup (`App.tsx:77`).

**Failure mode (shared device, supported multi-account login flow):** user A signs out; user B signs in the same tab. (1) B's session opens A's fully-populated local replica — local-first means the provider renders **A's entire dataset to B instantly**, until PowerSync's checkpoint for B's buckets eventually replaces it. (2) Worse: any of A's still-`pending` `client_commands` are uploaded by the watcher **under B's session cookie** — the dispatcher assigns `user_id` from the JWT (R17 working as designed, against you here), so A's offline creates become B's rows, and A's updates to A-owned rows spray `E_OWNERSHIP` rejections into B's review inbox. (3) S8-F2's `ROWS_CACHE` leak compounds on top.

**Suggested change:** on signout `await db.disconnectAndClear()` and clear `ROWS_CACHE`/`PRODUCED`; if pending commands exist, prompt first ("N unsynced changes will be lost — sync before signing out?") since clearing discards A's offline work. Sturdier: per-account `dbFilename` (`prisms-${userId}.db`) so account switching never shares state at all. Single-user self-hosting mitigates day-to-day, but the product ships a generic login screen — the flow is reachable.

### S9-F2 · High (mobile) — the only mobile export path calls `crypto.subtle`, which Expo/Hermes does not provide; no polyfill is present

**Evidence:** `apps/mobile/src/portability.ts:25-30` — export **requires** a passphrase (correct per §13.1) and calls the shared `serializeExport(manifest, { passphrase })` → `encryptExport` → `subtle()` which throws `'WebCrypto SubtleCrypto is unavailable in this runtime'` when `crypto.subtle` is absent (`packages/ui/src/portability/crypto.ts:32-36`). Hermes has no WebCrypto; mobile's dependencies include only `react-native-get-random-values` (polyfills `getRandomValues`, **not** `subtle`).

**Failure mode:** tapping export on mobile always throws — the encrypted-by-default mandate (V12/DoF 21) makes the feature 100% unavailable rather than degraded. Static analysis is conclusive about the missing API; runtime confirmation needs a device build (the standing M14 caveat, biting exactly where predicted in S8's handoff).

**Suggested change:** add a real WebCrypto provider for RN — `react-native-quick-crypto` (native, keeps PBKDF2 fast) wired to `globalThis.crypto.subtle`, or move mobile export encryption behind a platform port. Avoid pure-JS PBKDF2 fallbacks (210k+ iterations on Hermes = many seconds). Then actually run it on a device.

### S9-F3 · Medium-High — S1-F6 resolved: React 19.2.7 is force-resolved under RN 0.79.7 / Expo 53, an unsupported pairing; root cause is `@prisms/ui`'s dependency declaration

**Evidence:** `pnpm why react --filter @prisms/mobile` → **react@19.2.7** resolves for everything including `react-native@0.79.7` and `expo@53.0.27` (whose supported pairing is React 19.0.x). React Native's bundled renderer is version-locked to its paired React; 19.0→19.2 under RN 0.79 is outside the support matrix and a known source of renderer/hook runtime errors. The workspace override exists to keep one React per app for `@prisms/ui`'s hooks — but ui declares `react` in **`dependencies`** (`packages/ui/package.json:22`) rather than `peerDependencies`, which is the actual cause of the potential-duplicate-React problem the override papers over.

**Suggested change:** move `react` to `peerDependencies` in `@prisms/ui`, delete the workspace-wide `react: '19.2.7'` override, let mobile resolve Expo's 19.0.x and web its 19.2.x — each app then has exactly one React without global coercion. Verify with `npx expo-doctor` and a device build (the runtime proof this audit cannot produce). Until then, treat mobile runtime stability as unestablished.

### S9-F4 · Medium — S1-F7 confirmed: web PowerSync default port contradicts compose

**Evidence:** `apps/web/src/config.ts:9` — `VITE_POWERSYNC_URL ?? 'http://localhost:8081'` vs compose's `8080` default; CI remaps the container to fit (`ci.yml:71-76`).

**Suggested change:** as S1-F7 — default to `8080`, keep 8081 as the maintainer's local `VITE_POWERSYNC_URL`, delete the CI remap + comment.

### S9-F5 · Low — desktop shell hardening gaps

**Evidence:** `tauri.conf.json:24-26` — `"csp": null` (no Content-Security-Policy in the WebView; Tauri recommends setting one); `"plugins": {}` while the web bundle imports `@tauri-apps/plugin-notification` (Rust-side registration unverified — the M14 runtime caveat again); `withGlobalTauri: true` exposes the API globally. Confirmed good: desktop genuinely loads the identical web build (`frontendDist: ../../web/dist`, DoF-consistent with M14's key claim).

**Suggested change:** set a CSP (local assets + the API/PowerSync origins); verify notification-plugin registration in `src-tauri` during the first real desktop runtime pass; consider `withGlobalTauri: false` with explicit imports.

### S9-F6 · Low — `layout.renormalize_order` is unreachable end-to-end

**Evidence:** zero references in `apps/web/src` (and none in mobile); S5 established no server job issues it. The verb exists in the catalog, dispatcher, and effect builder — nothing can ever invoke it.

**Failure mode:** none acute (S8-F4: display order is stable via the id tiebreak); colliding fractional indices just accumulate crowding forever. **Suggested change:** either wire it (a maintenance action in Settings, or server-side after collision detection) or drop the verb from the catalog — a spec decision to record either way.

---

## Resolved handoffs

| Handoff | Resolution |
|---|---|
| S1-F6 React override vs Expo | **Confirmed unsupported pairing (F3)** + root cause identified (ui's `dependencies` declaration) + clean fix named. Runtime proof deferred to a device build. |
| S1-F7 port default | **Confirmed (F4).** |
| S8-F2 — does signout reload? | **No** — SPA-internal; S8-F2 stands at Medium and is **escalated/absorbed into F1** (the replica itself, not just the cache). |
| S8 — mobile `crypto.subtle` | **Confirmed missing (F2).** |
| S5 — renormalize reachable from any UI? | **No (F6)** — unreachable end-to-end. |
| S7 — device id via secure storage on installed targets (R13) | Mobile routes it through the expo-secure-store port (M14 design + dependency present — inventory-trust); web/desktop use localStorage with the real secret in the HTTP-only cookie (documented, acceptable). |

## Compliance checklist results

| Check (playbook §S9) | Result |
|---|---|
| Screens write only via `executeCommand` (DoF 1 client) | **PASS** — zero `execute(`/raw-write hits across all web screens |
| M9 surfaces + Review inbox (9 item types) + M10 flows | **PASS (inventory-trust)** — screens/routes present; covered by `m9.spec.ts`/`m10.spec.ts` e2e + M-session unit tests; not line-audited |
| Portability UI: installed encrypted-by-default, explicit plaintext opt-out + warning (V12/DoF 21) | **PASS (web/desktop)** — `Settings.tsx:101-103,191-203` (`isDesktop()` → passphrase required unless explicit opt-out); **mobile: mandatory passphrase enforced but the path likely throws → F2** |
| `config.ts` port default (S1-F7) | **FAIL → F4** |
| React resolution (S1-F6) | **FAIL (unsupported pairing) → F3** |
| Mobile parity: screens, secure storage, notifications | **PARTIAL (inventory-trust + runtime unverified)** — screens/tab present per M14; expo-secure-store dependency present; runtime = F2/F3 territory |
| Desktop: identical web build; config posture | **PASS on identity; hardening → F5** |
| PWA offline shell | **Not audited** (vite-plugin-pwa config unexamined — flag for Synthesis as a coverage gap) |
| e2e inventory vs CI claims | **PASS** — 10 specs (dod, s16–s20, m9, m10, m13, v14) exactly matching `ci.yml`'s description |

## Matrix updates applied (sequential mode)

- R1 → ⚠️ (all five platform targets exist and build; **mobile runtime hazard F2/F3, desktop runtime unverified** — DoF 23's smoke-test-or-documented-exception is the S10 question)
- R12 → ✅ UI half (web + mobile review screens present, e2e-covered) — full row now ✅ with S5-F1's lifecycle caveat noted
- R13 → ⚠️ (web ✅ honest; mobile impl present but runtime-unverified; F1's logout gap is the practical secure-storage hole on shared devices)
- V12 → ⚠️ (web/desktop installed-default ✅; mobile default path likely throws — F2)

## Handoff items (all to S10)

1. F1 + S8-F2 into the security roll-up (account-boundary on shared devices); check `docs/SECURITY_REVIEW.md` for any claim about logout/local-data clearing.
2. F2/F3: DoF 23 requires "platform smoke tests or a documented, accepted v1 exception" — neither mobile nor desktop has either; S10 must state this against the DoF.
3. F4 pairs with the S1-F7 CI cleanup; F5 into the hardening list; PWA config = declared coverage gap.

**Next:** Session 10 — security/perf/docs re-verification + Annex A prioritization + the consolidated `FINAL_REPORT.md`.
