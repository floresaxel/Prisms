# Prisms Architecture v1.3 - Annex A

Additional architecture recommendations for suggestions 2-9.

This annex is intended to attach to `ARCHITECTURE_1.3.md` and `BUILD_PLAN_REVISED_v1.3.md`. It does not replace v1.3. If adopted, these items should become normative additions in the next minor revision.

## A1. Device Registry

Purpose: make `device_id` trustworthy enough to support HLC ordering, command attribution, sync diagnostics, and lost-device revocation.

### Architecture Addition

Add a synced `devices` table:

```sql
CREATE TABLE devices (
  id text PRIMARY KEY,                 -- stable device_id
  user_id uuid NOT NULL,
  display_name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web','desktop','mobile','server')),
  app_version text,
  schema_version integer NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  public_key text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
```

Rules:

- Every command envelope carries `device_id`.
- The authenticated session/JWT must bind to the same `device_id`.
- The server rejects commands whose `device_id` does not match the authenticated device.
- Revoked devices cannot upload commands or subscribe to Sync Streams.
- Device rename is a named command: `device.rename`.
- Device revocation is a named command: `device.revoke`.
- The review/debug UI must show device name, platform, last seen, app version, schema version, and pending command count.

### Build Plan Additions

Add to S2:

- Device schema, `device.register`, `device.rename`, and `device.revoke` command schemas.

Add to S10/S11:

- JWT/session binding to `device_id`.
- Command dispatcher rejects mismatched or revoked devices.

Add to S15/S21/S22:

- Device settings screen and current-device display.

Verification:

- Command with mismatched `device_id` is rejected.
- Revoked device cannot upload or widen Sync Streams.
- Device rename syncs to all active devices.

## A2. Clock-Skew Guard

Purpose: prevent HLC ordering from being poisoned by a device clock far in the future.

### Architecture Addition

Define:

```text
MAX_FUTURE_SKEW = 5 minutes by default
CLOCK_SKEW_WARNING = 1 minute by default
```

Rules:

- The server extracts the physical-time component from every command HLC.
- If `hlc.physical_ms > server_now + MAX_FUTURE_SKEW`, reject the command with `clock_skew`.
- The rejection creates a `sync_review_items` row with `item_type = 'clock_skew'`.
- The server returns its current HLC floor in the rejection response.
- The client must merge that server HLC floor into its local HLC state before allowing retry.
- If skew is above `CLOCK_SKEW_WARNING` but below hard rejection, accept the command and create a warning review item.
- HLC monotonicity must remain local-device monotonic even after clock repair.

Extend `sync_review_items.item_type`:

```sql
'clock_skew'
```

### Build Plan Additions

Add to S2:

- HLC parser exposes physical timestamp.
- Clock-skew property tests.

Add to S11:

- Server clock-skew middleware in command pipeline before invariants.

Add to S12:

- Convergence case: future-skewed command is rejected, client repairs HLC, retry applies in correct order.

Verification:

- Far-future command cannot win HLC conflicts.
- Small skew creates warning but converges.
- Repaired device never generates an HLC lower than previously emitted local HLC.

## A3. Optimistic Mismatch Reconciliation

Purpose: handle the case where a command is accepted by the server but the visible canonical result differs from the optimistic overlay because another command won a conflict.

### Architecture Addition

Add command local terminal states:

```text
applied_confirmed
applied_overwritten
rejected
```

Rules:

- `applied_confirmed`: canonical row arrives and matches the optimistic visible result for the fields the command wrote.
- `applied_overwritten`: command applied successfully, but one or more written fields are no longer visible because a later HLC or deterministic merge won.
- `applied_overwritten` is not a failed command. It is a user-visible explanation.
- Material overwrites create or update a `sync_review_items` row with `item_type = 'applied_overwritten'`.
- Non-material overwrites may be logged without creating an open review item.
- The review detail must include command id, affected row, field names, optimistic value, canonical value, and winning command id if known.

Extend `sync_review_items.item_type`:

```sql
'applied_overwritten'
```

### Build Plan Additions

Add to S0:

- Accepted rename that is later overwritten by a newer rename produces `applied_overwritten`.

Add to S12:

- Two-device same-field conflict where both commands apply, but one becomes invisible and creates a review item.

Verification:

- Overlay reconciliation distinguishes `rejected` from `applied_overwritten`.
- The losing applied command is explainable from command history.
- No overlay remains after reconciliation.

## A4. Command Queue Crash Recovery

Purpose: make uploads safe across app crashes, process kills, network drops, and partial server responses.

### Architecture Addition

Extend `client_commands`:

```sql
ALTER TABLE client_commands ADD COLUMN upload_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE client_commands ADD COLUMN uploading_started_at timestamptz;
ALTER TABLE client_commands ADD COLUMN next_retry_at timestamptz;
ALTER TABLE client_commands ADD COLUMN last_upload_error text;
```

Rules:

- `uploading` is a leased state, not permanent.
- If a command is `uploading` longer than `UPLOAD_LEASE_TIMEOUT` (default 2 minutes), it returns to `pending`.
- Retry uses exponential backoff with jitter.
- Re-uploading the same command id is safe because server idempotency is keyed by command id.
- App startup runs `recoverCommandQueue()` before normal upload.
- `recoverCommandQueue()` resets expired `uploading` commands and cascades dependency state.
- A command stuck past `MAX_RETRY_WINDOW` creates a `sync_warning` review item but remains recoverable.

### Build Plan Additions

Add to S0:

- Simulate crash while command is `uploading`; restart and verify safe retry.

Add to S15/S21/S22:

- Startup calls `recoverCommandQueue()`.

Verification:

- Crash during upload cannot duplicate server effects.
- Crash after server apply but before local ack resolves via idempotent noop and canonical sync.
- Dependency commands remain parked until prerequisites recover.

## A5. Command-History Compaction and Redaction

Purpose: keep command history explainable without retaining sensitive payload text forever by accident.

### Architecture Addition

Add fields to `command_log`:

```sql
ALTER TABLE command_log ADD COLUMN payload_redacted_at timestamptz;
ALTER TABLE command_log ADD COLUMN redaction_policy text CHECK (redaction_policy IN ('none','payload','payload_and_effect_values'));
ALTER TABLE command_log ADD COLUMN compacted_at timestamptz;
```

Rules:

- Command history must preserve id, name, device, HLC, result, effect summary shape, provenance links, and timestamps.
- Redaction may remove sensitive payload values such as titles, descriptions, notes, focus review text, and imported content.
- Redaction must not break provenance, dependency, idempotency, or review item links.
- Export may include full command payloads or redacted command payloads depending on user-selected export privacy mode.
- A `privacy.redact_history` command performs redaction.
- A `history.compact` server job may compact old command effects after export/backup if the user enables it.
- Idempotency-dedup records remain intact for `MAX_OFFLINE_HORIZON` even if command payloads are redacted.

### Build Plan Additions

Add to S13/S23:

- `history.compact` job or explicit hardening task.
- Export privacy modes: full, redacted, minimal provenance.

Verification:

- Redacted command history still answers "why does this row exist?"
- Redaction does not break idempotency replay handling.
- Export/import round trip works for redacted exports.

## A6. Import Modes

Purpose: make import behavior precise for restore, merge, and user migration scenarios.

### Architecture Addition

Define import modes:

```text
restore_same_user
merge_into_current_user
new_user_from_export
```

Rules:

- `restore_same_user`: preserves user_id and row ids. Intended for disaster recovery into the same account or self-hosted restore.
- `merge_into_current_user`: remaps user_id to the current user and preserves row ids only if no collision exists.
- `new_user_from_export`: creates a new user identity and imports all rows under that identity.
- Import dry-run must report row-counts, collisions, unsupported versions, schema migrator needs, and privacy warnings.
- ID collisions must be handled by an explicit strategy: reject, remap, or skip.
- Imported command history is marked non-replayable in all modes.
- Imported HLC values are dominated by future local writes.
- Imported provenance uses `source_kind = 'import'` while preserving original provenance inside `source_detail.original_provenance`.

### Build Plan Additions

Add to S23:

- Implement all three import modes or explicitly defer non-v1 modes with docs and tests for rejection.

Verification:

- Restore same user preserves IDs.
- Merge mode detects and reports collisions in dry-run.
- New-user mode does not leak original user auth/secrets.
- Import then edit produces monotonic HLC ordering.

## A7. Local-First Search and Derived Indexes

Purpose: support fast navigation across a large personal knowledge/planning graph without making search a source of truth.

### Architecture Addition

Add a local-only search index:

```text
search_index: local-only SQLite FTS5 virtual table or equivalent platform adapter
```

Indexed content:

- node titles and descriptions,
- habit titles,
- decision board labels,
- review item titles,
- schedule suggestion reasons,
- optional command-history snippets depending on redaction settings.

Rules:

- Search index is derived and rebuildable.
- Search reads merged state: canonical replica plus optimistic overlay.
- Search index must not upload to the server.
- Import rebuilds search from imported facts.
- Redaction updates or rebuilds search index.
- Search results must carry row type, row id, rank, matched fields, and provenance summary.

### Build Plan Additions

Add to S15/S16/S20/S23:

- Local FTS setup.
- Command palette or global search surface.
- Rebuild-search command in diagnostics.
- 100k-node search perf test.

Verification:

- Offline search works after initial sync.
- Pending optimistic node appears in search.
- Rejected optimistic node disappears from search after rollback.
- Rebuilding search from facts produces identical results for a fixture.

## A8. Sync and Debug Diagnostics

Purpose: make the complex local-first runtime observable, supportable, and understandable.

### Architecture Addition

Add a local diagnostics view for development and optionally an advanced user view in production.

Diagnostics must show:

- current device id and schema version,
- Sync Stream subscription status by tier,
- last successful sync time,
- pending/uploading/applied/rejected command counts,
- oldest pending command age,
- overlay effect count,
- command queue recovery status,
- review item count by severity,
- last server job freshness for aggregates/scheduler/weather,
- local search index freshness,
- HLC clock state and clock-skew warnings,
- storage usage by table group,
- privacy-scrubbed recent errors.

Rules:

- Diagnostics logs must redact titles, descriptions, command payload values, time-entry detail, and provider secrets by default.
- A user can export a support bundle only after explicit consent.
- Support bundle must include version info, device metadata, schema versions, command counts, review item summaries, and sync/job freshness, not raw personal content.

### Build Plan Additions

Add to S15:

- Basic diagnostics route behind a dev/advanced flag.

Add to S23:

- Privacy-scrubbed support bundle export.

Verification:

- Diagnostics renders offline.
- Support bundle excludes task titles, descriptions, payload values, auth tokens, provider secrets, and raw time-entry detail.
- Simulated stuck command appears in diagnostics with retry state.

## A9. Suggested Session Mapping

If these annex items are adopted, update `BUILD_PLAN_REVISED_v1.3.md` as follows:

| Annex Item | Primary Sessions | Notes |
| --- | --- | --- |
| A1 Device registry | S2, S3, S10, S11, S15, S21, S22 | Add device table and auth binding before broad command work. |
| A2 Clock-skew guard | S2, S11, S12, S23 | Must be in convergence harness. |
| A3 Optimistic mismatch | S0, S11, S12, S15 | Distinguish rejected from applied-but-overwritten. |
| A4 Crash recovery | S0, S15, S21, S22, S23 | Startup recovery on every client. |
| A5 History redaction | S13, S23 | Keep provenance while reducing retained sensitive text. |
| A6 Import modes | S23 | Can be implemented late but must be specified early. |
| A7 Local search | S15, S16, S20, S23 | Derived local-only index. |
| A8 Diagnostics | S15, S23 | Make runtime supportable. |

## A10. Definition of Adopted

These annex recommendations are fully adopted when:

1. A registered, non-revoked device is required for every command upload.
2. Far-future HLC commands are rejected and cannot win conflicts.
3. Reconciliation distinguishes `rejected`, `applied_confirmed`, and `applied_overwritten`.
4. Upload crash recovery is idempotent and tested.
5. Command history can be redacted without breaking provenance.
6. Import mode is explicit for every import operation.
7. Local search works offline over merged canonical plus overlay state.
8. Diagnostics can explain sync and command-queue health without leaking personal content.

