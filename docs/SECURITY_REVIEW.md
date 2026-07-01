# Prisms — Security Review (v1.4, M15)

A review of the security-relevant contracts against the §13 checklist, grounded
in the shipped code (M0–M14). Each control names where it lives; residual risks
and deferrals are called out honestly at the end.

## 1. Command upload is the only trusted write path

- Clients never send SQL and never upload row patches. Optimistic writes land in
  the **local-only** overlay (`client_commands` + `overlay_effects`, kept out of
  `appSchema` so PowerSync never uploads them). The only upload is the named
  command envelope, driven by `startCommandUpload` reading `client_commands`
  (`packages/ui/src/powersync/connector.ts`, `upload-commands.ts`).
- The connector's `uploadData` is a **loud guard**: if any replica-table CRUD op
  ever reaches the PowerSync upload batch, it throws (`R15/§7.2`) rather than
  silently uploading. A compile-time-exhaustive coverage test proves every
  `CommandName` has an `executeCommand` writer (`packages/ui/test/effects.test.ts`
  → "the only trusted write path"), so the legacy CRUD-patch translator was
  deleted in M15 — nothing can regress onto it.
- The server dispatcher (`apps/server/src/dispatcher.ts`) is the sole mutation
  point: a 6-step pipeline (parse + strip trust fields → ownership from JWT →
  `depends_on`/causal check → core invariants → Drizzle txn → `command_log`).
  `computed_aggregates` is server-owned — a static test proves no command handler
  and no client path writes it.

## 2. Sync Streams auth + stream-parameter scoping

- Sync is edition-3 compiled **Sync Streams** (`packages/db/sync-streams.yaml`).
  Every stream query scopes on `auth.user_id()` (the verified JWT subject); there
  are **no client-widenable parameters** — a client cannot request another user's
  bucket. Tier 2 (`history`) is `auto_subscribe: false` and only ever narrows.
- The PowerSync token is a short-lived HS256 JWT the API mints from the Better
  Auth session (`GET /api/powersync/token`), signed with `POWERSYNC_JWT_SECRET`
  and scoped `sub = user_id`. The sync service validates it against the matching
  jwks key.
- Cross-user isolation is asserted in the convergence harness and the server
  integration suite (one user cannot receive another's rows).

## 3. The server owns trust (R17)

- The dispatcher **strips** client-supplied ownership/provenance/system/timestamp/
  `hlc`/`schema_version` *before* parse (a forged `user_id` is dropped, not
  rejected), then stamps server-authoritative values on every created/updated row.
  Zod payload schemas exclude trust fields entirely.
- Provenance (`source_kind`, `source_id`, `source_detail`, `created_by_command_id`)
  is server-assigned; the optimistic client may only *predict* `source_kind='user'`
  for overlay display, and the synced canonical value overwrites it.
- **Import** (`apps/server/src/jobs/import-restore.ts`) forces `user_id` to the
  importing account and stamps `source_kind='import'`. Because `id` is a global
  primary key, the restore looks up existing rows by id **without** a user filter
  and **skips** any id owned by another account — a cross-account import can never
  steal or overwrite another user's rows (proven in
  `apps/server/test/m13-portability.integration.test.ts`).

## 4. Causal ordering, rejection, and the review inbox

- Commands carry `depends_on`; the server applies a batch in HLC order and rejects
  a command depending on a rejected one (`dependency_rejected`) or referencing an
  unknown row (`unknown_target`). A command from a client below the row
  `schema_version` floor is rejected `client_too_old`.
- Every rejection, material HLC conflict (losing value preserved), stale
  suggestion, automation drift, and schema-version block creates a durable
  `sync_review_items` row that syncs to the user's Review screen (§7.13). Toasts
  point at items but never replace them.

## 5. Auth/session secrets + secure storage (§13.2/R13)

- The auth **session** is a Better Auth HTTP-only cookie on web/desktop (never in
  JS) and the React Native native cookie store on mobile — not in AsyncStorage or
  ordinary local storage.
- Non-session local material (device id, HLC floor) goes through the
  provider-neutral `SecureStorage` port (`packages/ui/src/adapters/`):
  localStorage on web, **expo-secure-store (OS keystore) on mobile**
  (`apps/mobile/src/secure-storage.ts`).
- Cookie-authenticated POSTs require a trusted `Origin` (CSRF); the API's own
  origin is always trusted and cross-origin clients are an explicit allow-list
  (`BETTER_AUTH_TRUSTED_ORIGINS`). `/sync/upload` is rate-limited per verb.

## 6. Local encryption + export behavior (§13.1/§13.2, R20)

- **Export excludes secrets:** `backup.snapshot` iterates the `tables` registry,
  which does not include the auth (`user`/`session`/`account`/`verification`) or
  push-subscription tables — so no auth token or provider secret can leave in an
  export (asserted in the integration test).
- **Export encryption:** optional passphrase encryption on web (AES-256-GCM with
  a PBKDF2-SHA256-derived key, 210k iterations; `packages/ui/src/portability/
  crypto.ts`); **encrypted by default on installed targets** (mobile requires a
  passphrase; desktop defaults the toggle on and requires an explicit opt-out with
  a warning). A wrong passphrase fails GCM authentication (never returns garbage).
- **Import is non-replayable:** it restores rows as data and marks
  `command_history` non-replayable; it never re-executes historical commands
  against an evolved schema.

## 7. Documented limitations (residual risk)

These are known and deliberately bounded, not undiscovered:

- **Local at-rest encryption on web/desktop.** The browser/OPFS replica is not
  encryptable from JS — the web replica is **unencrypted at rest**, so the device
  is the trust boundary. DB encryption sits behind an adapter port
  (`db-encryption.ts`); a SQLCipher-backed implementation for installed targets is
  future work, not wired in this build.
- **Cross-account import** requires id remapping to actually move data between
  accounts; today it safely **skips** colliding ids rather than remapping them
  (no data loss, no theft — but a cross-account restore is a no-op for colliding
  rows).
- **Far-future client HLC clamp.** A client that stamps an absurd future HLC only
  affects its own rows (LWW is per-row, per-user); a server-side clamp is a
  hardening nicety, not a cross-user exposure.
- **Automation write-amplification.** The in-txn automation fixpoint is bounded by
  `MAX_DEPTH=5` and depth-limit truncation raises a `sync_warning`, but cascades
  are not separately rate-limited.
- **Runtime-unverified surfaces on this build host.** Mobile (Expo), desktop
  (Tauri), and the alpha PowerSync stream-subscription API are typecheck/lint-
  verified here and exercised in CI / on dedicated runners, not on the Windows dev
  box.

## Checklist summary

| §13 control | Status |
|---|---|
| Command upload is the only trusted write path | ✅ enforced (loud guard + coverage test; CRUD path deleted) |
| Sync Streams auth + no client-widenable params | ✅ `auth.user_id()`-scoped; cross-user isolation tested |
| Trust fields server-assigned | ✅ stripped-then-stamped; import forces ownership + global-id guard |
| Secrets in secure storage | ✅ cookie / OS keystore; port-backed device secrets |
| Local DB encryption | ⚠ adapter port only (web/desktop plaintext at rest — documented) |
| Encrypted export | ✅ AES-256-GCM; default on installed targets |
| Export excludes secrets | ✅ registry excludes auth/push tables (tested) |
| Import non-replayable + HLC monotonic | ✅ restore-as-data + device HLC floor (tested) |
