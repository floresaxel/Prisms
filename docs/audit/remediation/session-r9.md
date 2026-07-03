# Remediation Session R9 — Account boundary + mobile viability

Branch `r09-account-mobile`, cut from the sequential integration head (`remediation` + R7 + R8). Findings addressed: **S9-F1 (High)** logout leaves the local replica + pending queue for the next account; **S8-F2** the read cache compounds it; **S9-F2 (High)** mobile export calls `crypto.subtle` Hermes lacks; **S9-F3** the React 19.2.7-under-RN-0.79 pairing is unsupported; **S8-F3** PBKDF2 iterations mis-cited vs OWASP; **S9-F5** desktop shell hardening. Decision **D6** (device run) exercised as far as this environment allows. Wave 1; playbook §R9.

## What changed

### 1. Logout boundary (S9-F1 + S8-F2) — web + mobile

- **Per-account database file.** `createDb(userId)` / `getDb(userId)` now open `prisms-${userId}.db` (web OPFS) / `prisms-${userId}.sqlite` (mobile) instead of a fixed `prisms.db`/`prisms.sqlite`. A different account on a shared device therefore never opens the previous account's replica **or** its `client_commands` queue — the core of the cross-account exposure (B rendering A's data; A's pending commands cross-posting under B's JWT).
- **Sign-out wipe.** New `clearLocalAccount(db, confirm)` in `apps/web/src/powersync.ts` (extracted from the inline handler so it is unit-testable): counts pending `client_commands`; if any, `confirm(pending)` gates the wipe (cancel → abort, stay signed in); on proceed `await db.disconnectAndClear()` (drops replica + queue) then `clearReadCaches()`. `App.tsx`'s `handleSignOut` calls it, and a `clearedRef` stops the unmount cleanup from double-disconnecting. Mobile mirrors this in `App.tsx` (native `Alert` confirm) + `powersync.ts` `clearDb()` (disconnectAndClear + drop the singleton so the next login re-opens fresh).
- **Read-cache clear (S8-F2).** New `clearReadCaches()` export in `packages/ui/src/hooks.ts` (next to `__resetReadCacheForTests`, the one hooks region R9 owns) empties the module-scoped SWR `ROWS_CACHE` + `PRODUCED` hydration registry and bumps the reactive `producedVersion`. Without it a warm read on a shared device serves the previous account's rows for a frame before the fresh replica loads.

### 2. Mobile crypto (S9-F2)

- Added `react-native-quick-crypto@^1.1.5` (+ its peers `react-native-nitro-modules`, `react-native-quick-base64`, `expo-build-properties`) — a **native** Nitro WebCrypto, so 600k-iteration PBKDF2 stays fast (a pure-JS fallback on Hermes would take seconds).
- `apps/mobile/src/crypto-polyfill.ts` — a **pure** `installWebCrypto(provider, target=globalThis)` that grafts `subtle` onto `globalThis.crypto` without clobbering a runtime that already has one, preserving the `getRandomValues` polyfill. No native import → runs under vitest.
- `apps/mobile/src/crypto-setup.ts` — the native seam: `install()`s quick-crypto then `installWebCrypto({ subtle })`. Imported for side-effect in `index.ts` **after** `react-native-get-random-values` and **before** the app (so `crypto.subtle` exists before any `serializeExport`).

### 3. React pairing (S9-F3)

- `packages/ui/package.json`: `react` moved from `dependencies` → `peerDependencies` (`^19.0.0`), no devDep copy (auto-install-peers gives ui's own toolchain a React; a devDep copy leaked a second React into mobile — see gotchas).
- `pnpm-workspace.yaml`: deleted the workspace-wide `react: '19.2.7'` override.
- `apps/mobile/package.json`: `react` pinned `^19.0.0` → **`19.0.0`** exact. Removing the override alone was **not** enough — the caret resolved to the newest 19.x (19.2.7), because Expo/RN peers are loose. Expo 53's supported pairing is exactly 19.0.0.
- `apps/mobile/metro.config.js` (**new**): the runtime dedup. `@prisms/ui` is a workspace package symlinked to one physical `packages/ui`, whose auto-installed peer React (19.2.x) a naive Metro resolve would bundle for mobile. The config redirects every `react`/`react-native` resolution to the app's own copy (19.0.0). (Not exercised by the JS gate — device-verified only; see below.)

### 4. Crypto parameters (S8-F3) — `packages/ui/src/portability/crypto.ts`

- `PBKDF2_ITERATIONS` 210k → **600k** (the real OWASP-2023 PBKDF2-**SHA256** floor; 210k is the SHA-512 figure, mis-cited). The envelope self-describes `iterations`, so old 210k files keep decrypting — zero migration.
- Decrypt now rejects an out-of-range `iterations` (`<1` or `>10_000_000`) with a typed error, so a crafted envelope can't pin the UI on a multi-billion-iteration KDF (a DoS nuisance; no confidentiality impact).

### 5. Desktop hardening (S9-F5) — `apps/desktop/src-tauri/tauri.conf.json`

- Real CSP (`default-src 'self'` + `connect-src` for API/PowerSync https/wss + localhost dev + `wasm-unsafe-eval` for wa-sqlite) replacing `csp: null`; `withGlobalTauri: false`.
- Notification plugin: **already correctly registered Rust-side** on inspection — `Cargo.toml` `tauri-plugin-notification`, `lib.rs` `.plugin(tauri_plugin_notification::init())`, `capabilities/default.json` `notification:default`. The audit's `plugins: {}` concern is a false alarm (that block is for JS-side plugin *config*, which notifications need none of). Runtime unverified (M14 caveat).

## Tests

- **`apps/web/test/logout-boundary.test.ts` (new, 5)** — the DoD test. `createDb` opens distinct per-account files; sign-out with unsynced commands + declined warning does **not** wipe (returns false, `disconnectAndClear` uncalled); no-pending wipes without prompting; **simulated A→B switch**: A renders its row (cache warm) → real `clearLocalAccount` (disconnectAndClear + `clearReadCaches`) → B's cold read renders **0 rows** (no A bleed); a control test omits the clear and shows the stale A row *would* bleed (count 1) — the fix is load-bearing.
- **`apps/mobile/test/crypto-polyfill.test.ts` (new, 3)** — the registration path: installs `subtle` on a Hermes-like (getRandomValues-only) runtime and preserves that RNG; no-op (doesn't clobber) when full WebCrypto already exists; creates crypto from scratch otherwise. Flipped mobile `vitest.config.ts` `passWithNoTests` → false (first real mobile test).
- **`packages/ui/test/portability.test.ts` (+2)** — new exports use the 600k floor; decrypt rejects out-of-range `iterations` while a fresh envelope still round-trips (back-compat).

## Evidence (gate)

- `pnpm turbo lint typecheck` — **14/14** (all 7 packages) on the new dependency graph. Only output: 3 pre-existing `no-console` unused-disable warnings in `load.perf.test.ts` / `perf.write-path.integration.test.ts` (R7/R8 files, out of scope).
- Tests: **ui 84/84**, **web 12/12** (incl. the 5 logout tests), **mobile 3/3**, and server/db integration + core all passed under `pnpm turbo test` **except** `core#test` timing out on 2 CPU-bound tests (`architecture-lint`, `optimize.property`) under 8-way turbo concurrency — the documented flake; **core passes 557/557 in isolation** (`pnpm --filter @prisms/core test`). Core/server/ui-runtime are untouched by R9.

### `pnpm why react` (DoD artifact)

```
# --filter @prisms/web  → Found 1 version of react  (19.2.7)      app copy: 19.2.7
# --filter @prisms/mobile → Found 2 versions: 19.0.0 + 19.2.7      app copy: 19.0.0
#   19.0.0  = the whole real tree (expo 53 / react-native 0.79.7 / react-navigation / @powersync/react-native)
#   19.2.7  = @prisms/ui's auto-installed PEER copy, used only when ui is built/tested standalone
#             (pnpm why react@19.2.7 --filter @prisms/mobile → via @prisms/ui). metro.config.js
#             redirects react → the app's 19.0.0 at BUNDLE time, so the duplicate never reaches the app.
```

Web is a clean single React. Mobile's *app* React is now 19.0.0 (the RN-0.79 pairing the audit wanted); the 19.2.x that remains is the shared-UI-package peer for standalone dev, deduped away at bundle time by `metro.config.js`.

### `npx expo-doctor` (16/18 pass)

- **Validates S9-F3:** `react@19.0.0` is **not** flagged — expo-doctor now accepts it as the SDK-53-expected version (forced 19.2.7 would have failed here). The new crypto deps (`react-native-quick-crypto`/`nitro-modules`/`quick-base64`/`expo-build-properties`) pass version validation.
- 2 checks fail, all **pre-existing / out of R9 scope**: (a) RN-Directory metadata advisories for `@journeyapps/react-native-quick-sqlite` (untested-on-new-arch) + no-metadata for the workspace/powersync packages; (b) SDK-version advisories for `react-native` 0.79.7↔0.79.6, `@types/react` 19.2.17↔19.0.10, `typescript` 6↔5.8.3, `react-native-safe-area-context`, `-screens`, `expo-secure-store`. These reflect deliberate monorepo-wide version choices (TS 6 everywhere; @types/react 19.2 shared with `@prisms/ui` to avoid dual React-types), not R9 regressions. Reconciling them is an Expo-SDK-alignment task, not this session's.

### Device run (D6) — **BLOCKED, needs a device/emulator** (no emulator in this environment)

Static half done (expo-doctor above; dep graph verified). The runtime proof was NOT run — do not read the above as a device pass. To complete on a machine with the Expo toolchain + an emulator/device:

```
pnpm --filter @prisms/mobile exec expo install --check   # reconcile the SDK-version advisories first
pnpm --filter @prisms/mobile exec expo prebuild --clean   # generate native projects (new-arch is on)
pnpm --filter @prisms/mobile run android                  # or: run ios  (dev build)
# 1) offline flow: maestro test apps/mobile/.maestro/worklist-offline.flow.yaml
# 2) manual export: Account → passphrase → Export; the share sheet must show an
#    ENCRYPTED blob ("prisms-export-enc" envelope), proving crypto.subtle works.
```

Watch for: a single React at runtime (no "invalid hook call"), and quick-crypto's native module loading (the nitro↔RN-0.79 native build is the untested surface — if it fails, `expo install --check`/`--fix` to reconcile the nitro version).

## Notes / gotchas / deviations

- **The workspace-package React dedup is the real subtlety of S9-F3.** The audit's fix (peerDeps + drop override) is manifest-level and assumes each app then resolves its own React. It doesn't, alone: (1) mobile's caret `^19.0.0` resolves to 19.2.7 (loose Expo/RN peers) → pinned to exact `19.0.0`; (2) a `react` devDep on `@prisms/ui` physically lands a second React in `packages/ui/node_modules` that Metro would bundle for mobile → removed (auto-install-peers still gives ui standalone a React); (3) even so the shared workspace package can only hold one `node_modules/react`, so `metro.config.js` forces the app's copy at bundle time. **Deviation from the playbook letter:** added `metro.config.js` (within R9's `apps/mobile/**` ownership) — the correct, standard Expo-pnpm-monorepo runtime fix; without it the manifest change is cosmetic for mobile runtime.
- **`clearLocalAccount` extraction** (deviation): the playbook implies inline sign-out logic; I extracted it into the R9-owned `apps/web/src/powersync.ts` purely for testability (behavior-preserving) so the DoD A→B test drives the *real* helper, not a copy.
- **Core turbo-concurrency flake** (same as R7's note): the 2 core timeouts are CPU starvation under 8-way concurrency, not R9 — see [[dev-stack-on-this-machine]]. Verify core in isolation.
- **Out-of-scope, reported not fixed:** S9-F6 (`layout.renormalize_order` unreachable end-to-end) — a spec decision (wire a Settings maintenance action or drop the verb) for R10; the pre-existing `no-console` lint warnings; the expo-doctor SDK-version advisories above.

## Handoff to R10

**SECURITY_REVIEW.md text (R10 applies — I don't edit docs):**

> **Account boundary on shared devices (S9-F1, remediated R9).** Sign-out ends the account's local presence: the client warns if unsynced commands would be lost, then `disconnectAndClear()`s the synced replica + local command queue and clears the in-memory read cache. Databases are per-account files (`prisms-${userId}.db`/`.sqlite`), so a second account on the same device never opens the first's replica or cross-posts its queued commands under the new JWT. Web + mobile; desktop is the identical web build.
>
> **Portable-export KDF (S8-F3, remediated R9).** Encrypted exports use PBKDF2-HMAC-SHA256 at 600,000 iterations (OWASP 2023 floor) with AES-256-GCM. Envelopes self-describe their `iterations`; decrypt honors 1..10,000,000 and rejects anything outside that range (DoS guard). Older 210k files still decrypt.
>
> **Mobile export crypto (S9-F2, remediated R9).** Mobile now provides native WebCrypto (`react-native-quick-crypto`) so the encrypted-by-default export path functions on Hermes. **Runtime unverified — pending a device build (DoF 23 / D6).**
>
> **Desktop shell (S9-F5, remediated R9).** WebView CSP set; `withGlobalTauri: false`; notification plugin registered Rust-side. Desktop runtime unverified (M14).

Also for R10: D6 is **BLOCKED — needs device** (record against DoF 23 as the "documented, accepted v1 exception" per the D6 ratified default if no runner materializes); the expo-doctor SDK-version advisories are candidates for a follow-up `expo install --check` pass; S9-F6 verb decision is open.
