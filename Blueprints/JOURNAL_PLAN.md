# Journal Feature — Build Plan (J0–J6, optional J7)

**Feature:** a note on any individual calendar day. Rich text (Markdown), full emoji
support on Android / iOS / Windows, **lazy month-bucketed sync** — a fresh device
pulls zero journal rows until a month is actually viewed — and **per-day `.md` export**
(single day on every platform; full archive on web/desktop, server-sourced so lazy sync
never truncates it).

**Branch:** `journal` off `main`. One commit per session (house rule). Gate per session:
`pnpm turbo lint typecheck test` (all 21), `@prisms/core test:coverage` ≥ 90 floor,
and (J4+) web Playwright e2e vs the live WSL stack. Merge PR at J6 with CI green.

---

## Design decisions (normative for all sessions — do not re-litigate)

### D1 — Data model: new synced table, not a node type
`journal_entries` — one live row per `(user_id, entry_date)` via a §7.7 partial unique
index. NOT a `node_type`: journals have no status, hierarchy, scheduling, or StatusIndex
involvement. Closest existing shapes: `habit_completions` (date-keyed arbiter) +
`tag_answers` (one current value per key, per-field LWW re-edit).

```
journal_entries
  ...baseColumns                      -- id, user_id, timestamps, hlc, schema_version, provenance
  entry_date  date        NOT NULL    -- the calendar day (explicit from the UI; no bucketDate)
  month_key   text        NOT NULL    -- 'YYYY-MM', server-derived from entry_date (see D3)
  content     text        NOT NULL DEFAULT ''   -- CommonMark markdown (see D2)

  UNIQUE (user_id, entry_date) WHERE deleted_at IS NULL       -- journal_entries_user_date_uq
  INDEX  (user_id, month_key)  WHERE deleted_at IS NULL       -- journal_entries_month
  CHECK  (month_key ~ '^\d{4}-\d{2}$')
```

- No cross-column `CHECK (month_key = <derived from entry_date>)`: `date::text` casts are
  DateStyle-dependent (not immutable) and `to_char` is only STABLE. The dispatcher derives
  `month_key` (`entry_date.slice(0, 7)`) and a J2 integration test asserts consistency.
- No generated column: logical replication of stored generated columns is PG-version-dependent
  (opt-in `publish_generated_columns` from PG17/18); a plain dispatcher-written column is
  version-proof.
- `ROW_SCHEMA_VERSION` stays 1 — adding a table is additive (§7.11 governs row-shape changes
  within a table).

### D2 — Rich text: CommonMark markdown in one `content` field
- Storage is **markdown text**, forever. Rationale: renders on every platform (web/Tauri via
  `react-markdown` + `remark-gfm`, RN via `react-native-markdown-display`), stays readable in
  the §13 export, keeps the merge model trivial (one LWW field — matches §7.3 semantics; no
  CRDT text merging, consistent with descriptions), zero vendor lock-in (R5 spirit).
- v1 editing UX on ALL platforms: multiline input + a formatting **toolbar** that inserts/wraps
  markdown at the selection (bold, italic, strikethrough, H1–H3, bullet/numbered/task list,
  link, inline code, code block, quote) + a preview toggle. The toolbar helper is a pure,
  unit-tested function shared web/RN.
- WYSIWYG (TipTap serializing to markdown) is **optional J7**, web/desktop only.
- Rendering is sanitized: raw HTML in markdown is NEVER rendered (react-markdown default —
  do not add `rehype-raw`; markdown-display does not execute HTML); link hrefs allowlisted to
  `http/https/mailto`.
- Concurrent edits to the same day: whole-content LWW by HLC (existing model). The LOSING
  content must not vanish silently — J2 surfaces it as a `sync_review_items` row
  (`hlc_conflict`) carrying the losing text in `detail`, so prose is recoverable from the
  review inbox.

### D3 — Lazy load: parameterized sync stream, month buckets
PowerSync bucket parameters match by **equality only** — hence `month_key`, not a date-range
predicate. New stream in `packages/db/sync-streams.yaml`:

```yaml
journal_month:
  auto_subscribe: false
  queries:
    - SELECT * FROM journal_entries
      WHERE user_id = auth.user_id()
        AND deleted_at IS NULL
        AND month_key = subscription.parameters() ->> 'month'   # J0-CONFIRMED: compiled + ACTIVE on 1.22.0
```

- Tombstones join the existing `history` stream (parity with `habit_completions`).
- Soft-delete propagation needs no tombstone in this stream: the row leaving the
  `deleted_at IS NULL` filter emits a REMOVE op to subscribed clients.
- **Access-control note:** this is the first stream reading a client parameter. Update the
  header comment in sync-streams.yaml: the invariant is now "no parameter ever WIDENS scope —
  every query still filters `auth.user_id()`; parameters only narrow within the user's own
  rows." Mirror the wording in ARCHITECTURE §7.3.
- Client: a ref-counted month-subscription manager (mirrors `subscribeHistory`,
  packages/ui/src/powersync/streams.ts — its `StreamSubscriber` type already accepts
  `syncStream(name, params?)`). TTL 3600s, priority 3. The Agenda subscribes the month(s)
  covering the visible week on mount/navigation (a week can span two months — subscribe both).
  Fresh device on today's Agenda ⇒ at most the current month's rows sync; nothing else, ever,
  until viewed.
- **Fallback (decided at J0 exit): ✅ NOT TRIGGERED — J0 confirmed parameterized streams
  compile + activate on service 1.22.0 (see J0 Findings).** Kept here for the record: if
  parameterized subscribe fails on the pinned service
  (powersync-service 1.22.0 / common ^1.54 / web ^1.38 / RN ^1.23), ship a single
  `journal` stream, `auto_subscribe: false`, whole-table, subscribed on first journal open.
  Coarser but preserves the "zero rows on fresh login" requirement; the month manager's API
  is written so only the subscription body changes.

### D4 — Commands (§8.1 additions)
- `journal.write` `{ id, entry_date, content }` — upsert keyed by `entry_date`, modeled on
  `tag.answer` (dispatcher.ts:1109). Insert path guards the race on the partial-unique arbiter:
  `onConflictDoNothing({ target: [user_id, entry_date], where: deleted_at IS NULL })`; if
  rowCount = 0, re-select the live row and fall through to the LWW-merge path (deterministic
  under concurrent same-day inserts — habit.check_off's DoNothing alone would drop content).
  Update path: `lwwFields(tx, hlc, userId, 'journal_entries', live.id, { content })`, apply
  winners with `...sys`. Payload `id` is used only on insert.
- `journal.delete` `{ id }` — ownership check + soft delete (`tag.clear_answer` shape).
- No invariants.ts case: ownership + the DB arbiter is the whole consistency story.
- Emoji are just Unicode through this path (UTF-8 in PG, UTF-16 JS strings, TEXT in SQLite).
  `content: z.string().max(100_000)` — the cap counts UTF-16 code units (document this).

### D5 — Upload-ack effects (shared infra fix; journal is the forcing function)
Two fresh offline devices writing the SAME new day mint different row ids. The server
converges onto the first-applied row and stamps `last_modified_by_command_id` on THAT row —
the loser's minted id never syncs down, so `reconcileConfirmed` (overlay-store.ts) never sees
its insert-effect "arrive" ⇒ ghost overlay note forever. (`tag.answer` has the same latent
edge today; upload-commands.ts confirms the ack carries only `id`/`result`.)

Fix (additive, backward-compatible):
1. J2 — the `/sync/upload` response gains optional per-command
   `effects: [{ table, row_id, op }]` (the dispatcher already records exactly this in
   `command_log.effects`).
2. J3 — `markApplied(commandId, effects?)`: when the ack's effect row_id differs from the
   local overlay's, REWRITE the local effect's `row_id` (and op insert→update) to the
   authoritative id — no flicker, and `reconcileConfirmed` then clears it normally when the
   canonical row arrives. Absent `effects` (old server), behavior is unchanged.

### D6 — Emoji support = fallbacks + safe truncation + tests (not storage)
- Web/desktop font stack: append `'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'`
  to `--px-font` (theme.css:15 currently has no emoji fallback). Windows input = Win+. into a
  plain input (works in Chromium + WebView2); iOS/Android = native keyboards into RN TextInput.
- NEVER truncate content with UTF-16 `.slice()` (splits surrogate pairs). One shared helper
  (`truncatePlain` in packages/ui, code-point-based via `Array.from`) for the day-panel
  preview snippet; ZWJ clusters may split cosmetically at the cut — acceptable; do NOT use
  `Intl.Segmenter` (unsupported on Hermes).
- Canonical test corpus, used at every layer:
  `'👍🏽'` (skin tone), `'👨‍👩‍👧‍👦'` (ZWJ family), `'🇫🇷'` (regional indicators), `'❤️'` (VS16),
  `'café'` + combining mark form, mixed RTL `'שלום 🌍 hello'`.

### D7 — Export: one `.md` file per day
Because storage is CommonMark text (D2), a day's export is the `content` field **verbatim** —
the date lives in the filename (`YYYY-MM-DD.md`), no frontmatter, no conversion, byte-lossless
(emoji included). Two surfaces:

- **Single day, all platforms:** an "Export .md" affordance on the open day panel. Source =
  the LOCAL row (viewing a day implies its month is subscribed, so it's always present).
  Web/desktop: Blob + anchor download (the `downloadExport` pattern, apps/web/src/
  portability.ts:37). Mobile: RN `Share.share` with the text (the `exportAndShare` §13
  precedent — zero new native deps).
- **Full archive, web/desktop:** Settings → "Export journal (.md archive)", next to the §13
  export. Source = the **SERVER**, never the local replica — under D3 a device may hold only
  the months it has viewed, so a locally-sourced "export all" would silently truncate on a
  fresh device. New endpoint `GET /sync/journal/export` (requireSession + rateGate, mirroring
  `/sync/export` at app.ts:155) returns all LIVE rows ordered by date:
  `{ entries: [{ entry_date, content, updated_at }] }`. The client packages one file per day —
  `journal/YYYY/YYYY-MM-DD.md` — into a zip via `fflate` (`zipSync`; new dependency of
  @prisms/ui: pure JS, tree-shakeable, runs in node/browser/Hermes) and hands the bytes to the
  platform (Blob download `prisms-journal_<stamp>.zip`, stamp format as `exportFilename`).
  - Client-side zip on purpose: the server surface stays JSON-only (§13 shape, body/rate
    limits already patterned), `buildJournalArchive(entries): Uint8Array` is pure and
    node-testable, and mobile can later reuse the same endpoint with a different hand-off.
    Mobile full-archive is DEFERRED exactly like §13 import was ("do it on web/desktop",
    apps/mobile/src/portability.ts:6); single-day share IS on mobile from J5.
- Encoding: `TextEncoder` UTF-8 → the zip carries exactly the bytes PG stored; the D6 corpus
  must round-trip `buildJournalArchive` → `unzipSync` byte-identical (unit-asserted). Archive
  paths are pure ASCII, so no zip-utf8-flag pitfalls.
- The §13 JSON manifest still includes `journal_entries` via the tables registry (J1) — the
  `.md` archive is an ADDITIONAL human-readable product, not the backup, and is NOT an import
  format (JSON import remains the only restore path; `.md` import is a J7+ candidate at most).

---

## Sessions

### J0 — Spike: parameterized streams + emoji round-trip on the live stack (~½ session)
Throwaway branch/worktree; nothing merges except findings appended to this file.
1. Bring up the WSL stack; add a scratch parameterized stream over an existing table (or a
   scratch table) to sync-streams.yaml; client-side `db.syncStream(name, {month}).subscribe()`
   from a scratch page/test.
2. Verify: (a) exact parameter syntax accepted by the service parser
   (`subscription.parameters() ->> 'month'` vs `subscription.parameter('month')`) — pin it in
   D3; (b) rows arrive ONLY after subscribe; (c) two different parameter values = two
   independent buckets; (d) unsubscribe + TTL eviction removes local rows; (e) subscribe
   while offline → reconnect → bucket syncs (the M14 assumption, now with params);
   (f) `check-sync-rules.ts` accepts the stream.
3. Emoji probe piggyback: write the D6 corpus through an existing command (e.g.
   `node.set_description`) → PG → sync → SQLite → read back byte-identical.
   `SHOW server_encoding` = UTF8 on the compose Postgres.
4. **Exit:** go/no-go on parameterized streams recorded here; fallback (D3) triggered or not.
   Sanity: `git checkout` away the scratch stream.

#### J0 — FINDINGS (recorded 2026-07-04) → **GO. D3 fallback NOT triggered.**
Method: scratch table `_j0_journal` (id/user_id/month_key/content) added to the `powersync`
publication; two scratch streams `journal_probe_a` (`subscription.parameters() ->> 'month'`)
and `journal_probe_b` (`subscription.parameter('month')`) over it; driven against the live WSL
stack (postgres:16 + journeyapps/powersync-service:**1.22.0**). All scratch artifacts reverted
after (yaml `git checkout`, table dropped, service recompiled to a clean probe-free ACTIVE
ruleset — verified `id=5 state=ACTIVE has_probe=f no_fatal=t`).

- **(2a) Parameter syntax — BOTH forms valid, syntax A pinned.** Offline parser
  `@powersync/service-sync-rules@0.37.0` (the exact engine `sync-rules:check` runs) registers
  both `subscription.parameters()` (returns the params JSON as TEXT → `->> 'month'`) and
  `subscription.parameter('month')` (single-key extract). **Pinned: `subscription.parameters()
  ->> 'month'`** (text-typed both sides of the `month_key =` equality; matches PowerSync's
  documented form). `auto_subscribe: false` is **mandatory**, not stylistic — the compiler
  emits a warning if a parameterized stream auto-subscribes (default-subscription passes null
  params). D3 already specifies false.
- **(2f) `check-sync-rules.ts` accepts it** — `sync-streams.yaml: valid` with both probes.
- **Live 1.22.0 compiles + activates it (the real compatibility gate).** The service ingested
  the changed rules into `powersync_storage.powersync.sync_rules` as a new row
  `state=ACTIVE, last_fatal_error=null` carrying both param syntaxes (prior probe-less rulesets
  → `TERMINATED`). A failed compile could never reach ACTIVE. NB: the offline 0.37.0 parser is
  only *necessary*; this ACTIVE row on the pinned image is the *sufficient* evidence.
- **(2c) Parameter compiles to a BUCKET KEY (distinct month ⇒ distinct bucket).** The persisted
  `sync_plan` shows `dataSources[].partitionBy … column = "month_key"` and the stream querier
  `parameters: [{source.request:"subscription"}, {value:"month"}]` — i.e. the client
  subscription param `month` is wired into a `month_key`-partitioned bucket. So two month values
  address two independent buckets; with `auto_subscribe:false` nothing flows until subscribed
  **(2b** holds by construction).
- **(2d TTL eviction / 2e offline→reconnect / end-to-end client delivery): NOT exercised in
  J0** — no pure-node PowerSync client exists in the repo (client is browser wa-sqlite / RN
  quick-sqlite). Deferred to **J3** (subscription-manager + convergence harness) and **J6**
  (Playwright fresh-device lazy-load proof), where the real client runs. Residual risk LOW:
  the bucket is parameter-partitioned in the ACTIVE plan and M-series already runtime-verified
  edition-3 stream transport (incl. lazy `history`) on this exact 1.22.0 image.
- **(3) Emoji round-trip — byte-identical through Postgres.** `SHOW server_encoding` = **UTF8**
  (client_encoding UTF8). The full D6 corpus inserted via the driver and read back matched on
  `md5(content)`, `octet_length`, `char_length`, AND `content = <js string>` for every case:
  `👍🏽`(2cp/8B) · `👨‍👩‍👧‍👦`(7cp/25B) · `🇫🇷`(2cp/8B) · `❤️`(2cp/6B) · combining-`café`(5cp/6B) ·
  `שלום 🌍 hello`(12cp/19B). The PG boundary is lossless; the SQLite/JS-UTF16 leg is lossless by
  construction and is re-asserted at every layer in J2/J3.
- Tooling note: nested-quote hell across PowerShell→WSL→docker→psql — drive Postgres from a
  Node `postgres` script (workspace dep) or pipe SQL via **stdin** to `psql -f -`; avoid
  `psql -c "…$$…"` (WSL `sh` expands `$$` to a PID inside double quotes).

### J1 — Schema, core domain, command payloads, sync config
`packages/core`:
- `domain/entities.ts`: `journalEntrySchema` (`...baseRow, entry_date: isoDateSchema,
  month_key: z.string().regex(/^\d{4}-\d{2}$/), content: z.string().max(100_000)`); register
  in `entitySchemas` (drives the s03 Drizzle-parity assertion).
- `commands/payloads.ts`: `journalWriteSchema` (strictObject `{ id, entry_date, content }` —
  month_key is server-derived, NOT in the payload), `journalDeleteSchema` (idOnly); register
  `'journal.write'` / `'journal.delete'` in `COMMAND_SCHEMAS` (DoD strictness test picks them
  up automatically).
- Unit test: D6 corpus passes the payload schema and JSON round-trips unchanged.

`packages/db`:
- `src/schema.ts`: table per D1 + add to the `tables` registry (⚠ this is what auto-includes
  journals in `backup.snapshot` and §13 export/import — the job iterates the registry).
- `src/type-assertions.ts`: parity entry.
- Migration `0010_journal.sql` (+ drizzle meta snapshot): CREATE TABLE, partial unique, month
  index, CHECKs, **and `ALTER PUBLICATION powersync ADD TABLE journal_entries;`** (⚠ R10:
  the publication is scoped — omit this and sync silently delivers nothing; runs after 0009
  in every era, including the plain-test-DB path where 0009 created the publication).
- `sync-streams.yaml`: `journal_month` per D3 (J0-pinned syntax), tombstone query added to
  `history`, header invariant comment updated. `check-sync-rules` green.
- Seed (`src/seed.ts`): a couple of sample notes **with explicit `schema_version`** (0f6b95d
  lesson) spanning two months (J6 uses this).

Docs: ARCHITECTURE.md §6.0 table, §8.1 verbs, §7.3 stream table + parameter-invariant wording.
**DoD:** gate green; migration applies on a fresh DB and on a copy of a populated one.

#### J1 — AS BUILT (2026-07-04) → **DONE, gate green.** `pnpm turbo lint typecheck test` all
green (core 563 · db 49 · server 126 · ui/web units); `@prisms/core` coverage 90.47% stmts
(≥90 floor). Migration **0010_journal** applies fresh (integration test, full 0000→0010 chain)
AND on the populated dev DB (317 nodes preserved; journal_entries created + added to the scoped
`powersync` publication). The **real** `journal_month` stream compiles + ACTIVATES on live
1.22.0 (sync_rules id ACTIVE, no fatal error) — not just J0's probe.

Deviations / discoveries (read before J2/J3):
- **The 2 command verbs are an ATOMIC 3-package edit.** Registering `journal.write`/`.delete`
  in core `COMMAND_SCHEMAS` widens the `CommandName` union, which breaks the EXHAUSTIVE switches
  in ui `effects.ts` (`default: const _exhaustive: never = name`) and server `dispatcher.ts`
  (no default — TS "must return" makes it exhaustive) at **typecheck**. So J1 necessarily shipped
  the client optimistic effect + the server dispatcher case too (the plan had penciled them for
  J3/J2). They are the REAL handlers, so J2/J3 only ADD around them — no rewrite:
    - **J2 still owns:** hardening the insert against the §7.7 arbiter race
      (`onConflictDoNothing({target:[user_id,entry_date], targetWhere: deleted_at IS NULL})` +
      re-select-merge), the `hlc_conflict` review item carrying the losing content, the
      `/sync/upload` `effects` response, PURGE_ORDER, the export endpoint, integration tests.
      J1's dispatcher is the tag.answer-shaped load-then-insert-or-LWW-merge + ownership +
      `E_DUPLICATE` + server-derived month_key + `rec()` effect logging (ack-effects-ready).
    - **J3 still owns:** client schema.ts/rows.ts/commands.ts/streams.ts/hooks.ts + the
      ack-rewrite. J1's `effects.ts` case is the final `ins('journal_entries', …)` from D3.
- **`journalEntrySchema` follows the 1.3 precedent, NOT the plan's "register in entitySchemas".**
  `schedule_suggestion_batches`/`sync_review_items` are synced tables that live in `schema.ts` +
  `type-assertions.ts` but are NOT in core's `entitySchemas` (frozen at the 22 §6.0 tables).
  Journal matches them: parity is proven by `AssertJournalEntries` in type-assertions.ts, so
  `entities.test.ts` (`toHaveLength(22)`) was left untouched.
- **Registry completeness also required:** import-restore `RESTORE_ORDER` (journal_entries at
  level 0 — else backup-snapshot's always-present `journal_entries:[]` key trips the "unknown
  table" warning on every import); catalog.test.ts count 59→**61**; sync-streams.test.ts
  "no parameter" test rewritten to the D3 "parameters only NARROW; every query still
  auth.user_id()" invariant; integration.test.ts table list (+journal_entries) & seed summary
  (+`journal_entries: 2`).
- **Migration** was `drizzle-kit generate --name journal` (clean single-table diff) then the
  `ALTER PUBLICATION powersync ADD TABLE journal_entries;` hand-appended (drizzle can't know the
  scoped publication). CHECK uses `[0-9]` not `\d` (Drizzle's `sql` template is JS — `\d` would
  drop its backslash).
- **Docs:** ARCHITECTURE.md left UNCHANGED. It is frozen "Version 1.0" — its §6.0/§8.1/§7.3 never
  gained tags/review/suggestion-batches/streams, so a journal-only edit would be a lone
  inconsistency. THIS file (JOURNAL_PLAN.md) is the journal feature's living spec.

### J2 — Server: dispatcher, ack effects, jobs
`apps/server/src/dispatcher.ts`:
- `journal.write` per D4: `existingById` guards first (ownership reject; same-user id bound to
  a DIFFERENT entry_date ⇒ `E_DUPLICATE`, mirroring tag.answer's placement guard), then live
  row by `(user_id, entry_date)`, insert-with-arbiter-race-fallback or LWW-merge; `month_key`
  derived server-side; provenance via `born`/`sys` as everywhere.
- `journal.delete`: ownership + soft delete.
- LWW loss on `content` ⇒ create a `sync_review_items` row (`item_type: 'hlc_conflict'`,
  severity info/warning) whose `detail` carries the losing content (D2). First check whether
  `lwwFields` losses already emit review items generically — if yes, verify content flows
  through `detail`; if no, emit specifically for `journal.write`.
- `/sync/upload` response: add optional per-command `effects` from the dispatcher's recorded
  effects (D5 part 1; additive to the response schema).
- `GET /sync/journal/export` per D7: requireSession + rateGate (`:journal-export` key), all
  live rows for the user ordered by `entry_date`, shape
  `{ entries: [{ entry_date, content, updated_at }] }`. No zip server-side.

Jobs: add `journal_entries` to `PURGE_ORDER` (retention-purge.ts:33 — ⚠ omit it and
tombstones are never reclaimed, the S5-F1 bug class; no FK dependents, position free).

Integration tests (live PG via `PRISMS_DB_TEST_URL`):
- Convergence: two device ids, same `entry_date`, different minted ids, out-of-order HLC
  arrival ⇒ ONE live row, HLC-winning content, loser surfaced in review inbox.
- Arbiter race fallback path (simulated conflict ⇒ merge, not silent drop).
- Soft-delete → re-create same date through the partial unique.
- Ownership rejection; `E_DUPLICATE` id-rebind rejection.
- D6 corpus round-trips byte-exact (compare code-unit sequences).
- `backup.snapshot` manifest contains `journal_entries`; `import.validate`/`import.restore`
  round-trip the rows (registry-driven — assert, don't assume).
- month_key consistency: dispatcher-derived value always equals `entry_date.slice(0,7)`.
- `/sync/journal/export`: owner-scoped (other user's rows never appear), live rows only
  (soft-deleted excluded), date-ordered, D6 corpus byte-exact through HTTP, 401 without
  session, rate-gate returns Retry-After.

**DoD:** gate green; command_log rows carry effects; review-inbox recovery path proven.

#### J2 — AS BUILT (2026-07-04) → **DONE, gate green** (core flake `architecture-lint`
re-run passes in isolation; coverage 90.43% stmts). 13 new journal integration tests
(`journal.integration.test.ts` dispatcher+jobs, `journal-http.integration.test.ts` D7 HTTP).

Key findings / deviations:
- **`lwwFields` ALREADY surfaces losing content generically** (`maybeHlcConflict`,
  dispatcher.ts:~439) — an `hlc_conflict` review item whose `detail.losing_value` carries the
  loser. So the "incoming edit LOSES" path needed only verification. The subtle gap J2 had to
  add: the **out-of-order** case where the incoming write WINS and overwrites a DIFFERENT
  device's row — the generic path never fires there, so the overwritten prose would vanish.
  Fix: after a winning cross-device merge, call `maybeHlcConflict` with the prior content as the
  loser. **`crossDevice = live.id !== p.id`** cleanly distinguishes a cross-device collision
  (surface a conflict) from a user's own sequential same-id edit (never a conflict).
- **Arbiter race:** `onConflictDoNothing({target:[user_id,entry_date], where: deleted_at IS
  NULL})` + returning() → if 0 rows, re-select the live row and merge (never error/drop). NB the
  drizzle option is `where` (the partial-index predicate), NOT `targetWhere`.
- **D5 ack effects:** threaded the handler's `EffectSummary[]` out of the txn into
  `CommandOutcome.effects` as minimal `{table,row_id,op}` (added to core `commandOutcomeSchema`).
  Included ONLY when non-empty, so the settings/noop exact-match response tests are untouched.
  A winning cross-device merge recs `update` on the AUTHORITATIVE row id (≠ the losing minted
  id) — that divergence is exactly what J3's `markApplied` rewrites. `rec()` also runs on the
  LOSS branch so the client still learns the authoritative row.
- **Export (D7):** `runJournalExport` job (owner-scoped, live-only, date-ordered) +
  `GET /sync/journal/export` (requireSession + shared `rateGate`, fixed endpoint limit 30).
  Server-sourced — never the local replica (lazy sync would truncate).
- **PURGE_ORDER** += journal_entries (no dependents; omitting it = S5-F1 tombstone leak).
- **Test gotcha:** the command envelope id (dedup key) MUST be fresh per command — conflating
  it with the journal ROW id makes a delete/rebind look like an idempotent replay (noop).

### J3 — Client store: schema, mappers, effects, commands, month subscriptions
`packages/ui/src/powersync/`:
- `schema.ts`: `journal_entries` Table (user_id, entry_date, month_key, content, created_at,
  updated_at, deleted_at — minimal like `tags`; synced, NOT localOnly).
- `rows.ts`: `toJournalEntry`.
- `effects.ts`: `journal.write` ⇒ `ins('journal_entries', id, { entry_date,
  month_key: entry_date.slice(0,7), content })`; `journal.delete` ⇒ `del`. (Insert-as-upsert
  is correct for the merged read: edits pass the existing row id, so `ins` only creates when
  the day is genuinely new — the tag.answer precedent at effects.ts:257.)
- `commands.ts`: `writeJournal({ existingId?, entryDate, content })` — payload id =
  `existingId ?? newId()` (the hook supplies the live row's id when editing; the answerTag
  pattern); `deleteJournal(id)`.
- `overlay-store.ts` + `upload-commands.ts`: D5 part 2 — `markApplied(commandId, effects?)`
  rewrites id-divergent local effects to the authoritative row id; `uploadClientCommands`
  passes the ack's effects through.
- `streams.ts`: `JournalMonthSubscriptions` — `hold(monthKey): () => void`, ref-counted per
  month, TTL 3600s, prio 3, params `{ month: monthKey }`; unsubscribe on release (TTL evicts).
- `hooks.ts`: `useJournalMonths(monthKeys: string[])` (holds subscriptions for the visible
  month(s) + reactive rows) and `useJournalDay(date)` derived from it.

`packages/ui/src/portability/journal-md.ts` (D7; + `fflate` dep in @prisms/ui):
- `journalDayFilename(entryDate): 'YYYY-MM-DD.md'`; `journalArchiveFilename(atIso)`
  (`prisms-journal_<stamp>.zip`, same stamp scheme as `exportFilename`).
- `buildJournalArchive(entries): Uint8Array` — `zipSync`, path `journal/YYYY/YYYY-MM-DD.md`,
  content UTF-8-encoded verbatim; deterministic entry order (by date) for testability.

Unit tests: journal-md — archive structure/paths, D6 corpus byte-identical through
`buildJournalArchive`→`unzipSync`, empty-content day still emits its file; effect purity
incl. D6 corpus; mapper; subscription manager state machine (mock
`StreamSubscriber`: refcount, re-hold before TTL, param passthrough); **ack-rewrite
convergence** (simulated two-device same-new-day: after applied-ack with divergent effects,
merged read shows exactly one row for the date, before AND after canonical arrival);
offline-write-then-reconnect keeps the note visible throughout (overlay persists until
canonical row lands — S7-F6 semantics now exercised for a parameterized stream).

**DoD:** gate green; convergence harness (the M-series SQLite harness) covers the new paths.

#### J3 — AS BUILT (2026-07-04) → **DONE, gate green** (core `architecture-lint` flake passes
in isolation; coverage 90.39%; ui 100 tests, +11 journal). Shipped: PowerSync `journal_entries`
Table (minimal, synced), `toJournalEntry`, `writeJournal`/`deleteJournal` (answerTag upsert
shape), the `JournalMonthSubscriptions` ref-counted month manager, `useJournalMonths`/
`useJournalDay`, the D5 `markApplied` ack-rewrite, and `buildJournalArchive` (fflate).

Key findings / deviations:
- **The D5 loser-overlay resolves for free** because the CLIENT `journal_entries` schema OMITS
  `last_modified_by_command_id` (minimal, like `tags`). So `reconcileConfirmed` falls back to
  PRESENCE-only for journal — the moment the winning canonical row (by the rewritten id) arrives,
  the overlay clears. No stamp-mismatch stuck overlay; the losing content lives in the review
  inbox (J2). The `markApplied` rewrite therefore only needs to fix the row_id (+ `fields.id`,
  else the insert-seed's `id` corrupts the row keyed under the new id) + op→update.
- **`markApplied` keeps a single-statement fast path** when nothing diverges (`sql.execute`),
  opening a `writeTransaction` ONLY for an actual rewrite — otherwise the connector test (which
  asserts the db-level `execute` saw `status='applied'`) breaks, since a txn routes through
  `tx.execute`.
- **Rewrite matching** is per-(command,table) with EXACTLY ONE local effect on the table (the
  minted-id upsert shape: journal.write / tag.answer …); multi-effect commands are left untouched.
- **`mergeRow` is NOT hlc-aware** (an overlay always overrides the replica) — that's WHY the
  rewrite (not just keeping the stale insert) is required to avoid a phantom-id row; the plan's
  "exactly one row before AND after canonical" is asserted on real better-sqlite3.
- **Test harness:** the real `createSqlOverlayStore` runs on a better-sqlite3 `:memory:` handle
  (added to @prisms/ui devDeps; already built for @prisms/server). The M7 server `Device` harness
  is a SEPARATE simulation (columns `tbl`, own reconcile) — it does NOT use the real store, so the
  faithful D5 test lives in ui. Deps added: `fflate` (dep), `better-sqlite3`/types (devDep).
- **Coupling:** `appSchema` is now 23 synced tables (overlay-spike.test.ts updated 22→23).

### J4 — Web UI: Agenda integration + markdown editor/renderer
`apps/web/src/screens/Agenda.tsx` + new `components/DayJournal.tsx` (+ `packages/ui` helpers):
- Day-column headers (`px-cal-col-head`) get a note affordance: dot when the day has a live
  note (month data is already local via `useJournalMonths(visible months)`), click selects the
  day; the left panel swaps to `DayJournalPanel` (exact pattern of the selected-block
  `BlockTagsPanel` swap).
- Editor: textarea + toolbar (pure `applyMarkdownEdit(selection, action)` helper in
  packages/ui, unit-tested) + preview toggle; save on blur + 800ms debounce via
  `writeJournal`; delete button ⇒ `journal.delete`; empty-content saves are allowed (explicit
  delete only — keeps dispatcher semantics simple).
- Rendering: `react-markdown` + `remark-gfm`, raw HTML disabled, `urlTransform` allowlist
  (http/https/mailto). Task-list checkboxes render disabled in v1 (interactivity in J7 if
  ever).
- `theme.css`: emoji fallbacks appended to `--px-font` (D6).
- `truncatePlain` code-point helper for the header dot tooltip / any snippet.
- Skeleton/hydration state while a month's first sync is in flight (reuse `useIsHydrated`
  pattern + `waitForFirstSync`).
- Week spanning two months subscribes both (test).
- Export (D7): "Export .md" in the day panel (local content → Blob download, named by
  `journalDayFilename`); Settings gains "Export journal (.md archive)" beside the §13 export —
  `fetchJournalExport()` in apps/web/src/portability.ts (the `fetchExport` shape) →
  `buildJournalArchive` → Blob download (`application/zip`).

Component tests (vitest + the existing screen-test setup): dot presence, panel swap, toolbar
inserts around a selection containing `'👨‍👩‍👧‍👦'`, preview renders bold/list/link, hostile
markdown (`<script>`, `javascript:` link, `<img onerror>`) renders inert; day-panel export
downloads exactly the entered content as `YYYY-MM-DD.md`; Settings archive button (mocked
fetch) triggers a zip download whose entries match the mocked days.
**DoD:** gate green; manual Win+. emoji input check on Windows Chromium + Tauri dev build.

#### J4 — AS BUILT (2026-07-04) → **DONE, gate green** (core `architecture-lint` + `optimize`
property tests flake on CPU-starved parallel turbo runs — both pass @prisms/core in isolation;
coverage 90.43%). Web +20 tests (13 ui markdown, 7 web components → 8 with the archive test).
Shipped: `applyMarkdownEdit`/`truncatePlain` (packages/ui/src/markdown.ts, pure), the
`DayJournalPanel` + `MarkdownView` (apps/web/src/components/DayJournal.tsx), Agenda day-header
note dot + panel swap, `theme.css` emoji font stack (`--px-font`), and both export surfaces
(day-panel Blob download + Settings `.md` archive via `downloadJournalArchive`).

Key findings / deviations:
- **Sanitized renderer:** `react-markdown`@9 + `remark-gfm`@4, NO `rehype-raw` (raw HTML stays
  escaped text), `urlTransform` allowlists `http/https/mailto`. Tested inert against `<script>`,
  `javascript:` links, and `<img onerror>` — the security-critical test.
- **Editor:** textarea + shared toolbar (`applyMarkdownEdit` on the DOM selection) + preview
  toggle; save debounces 800ms + flushes on blur; `existingId` (from the reactive `useJournalDay`)
  makes edits patch the live row, a new day mints one. Panel keyed `key={date}` so it re-inits
  per day; a `dirty` ref adopts synced content without clobbering an in-progress edit.
- **`Uint8Array`→`Blob` (TS 5.7 variance):** fflate returns `Uint8Array<ArrayBufferLike>` which
  isn't a `BlobPart`; wrap in a fresh `new Uint8Array(...)` (plain ArrayBuffer).
- **Test harness:** the repo screen-test pattern = `.test.ts` + `createElement` (no JSX) +
  `// @vitest-environment jsdom`, mock `@prisms/ui` hooks via `importOriginal` (keep the pure
  helpers real). The full Agenda renders under that mock (dot date computed with real `bucketDate`
  so it's not time-flaky). fflate added to @prisms/web devDeps (for the archive round-trip test).
- **Deps:** `react-markdown`/`remark-gfm` (web deps); `fflate` (web devDep).
- Not done (needs a human): the manual Win+. emoji input check on Windows Chromium + Tauri.

### J5 — Mobile (Expo RN) + desktop parity
`apps/mobile/src/screens/Agenda.tsx` + new `JournalDay` screen/modal:
- Day affordance on the mobile agenda; editor = multiline `TextInput` + the SAME shared
  toolbar helper + preview via `react-native-markdown-display` (no HTML execution; link press
  handler allowlists schemes).
- Month subscriptions keyed to the visible range; offline write → visible immediately
  (overlay) → syncs on reconnect (manual + harness test).
- Native emoji keyboards (iOS/Android) round-trip the D6 corpus; snapshot test of rendered
  markdown with corpus content on Hermes (no Intl.Segmenter anywhere — CI-greppable).
- Single-day export (D7): share button on the day screen → `Share.share({ title:
  'YYYY-MM-DD.md', message: content })` via `journalDayFilename` (portability.ts precedent).
  Full-archive stays web/desktop-only; the parity checklist records that as intentional.
- Desktop (Tauri = same web build): verify WebView2 renders color emoji with the J4 font
  stack AND that the J4 archive download lands via the WebView2 download path; checklist only.

**DoD:** gate green; parity checklist in this file ticked (mobile create/edit/delete/offline,
emoji corpus rendered on both OSes via Expo Go or dev build).

#### J5 — AS BUILT (2026-07-04) → **DONE, gate green** (mobile +1 test; core coverage 90.47%).
Shipped: `apps/mobile/src/screens/JournalDay.tsx` (multiline `TextInput` + the SAME
`applyMarkdownEdit` toolbar, tracking the RN selection via `onSelectionChange`; preview via
`react-native-markdown-display`@7 with `onLinkPress` allowlisting http/https/mailto; 800ms save +
flush-on-blur; Delete; Share `.md` via RN `Share.share({title: journalDayFilename(date), message:
content})`), and the mobile Agenda `Journal` day-picker (7 days, `useJournalMonths` holds the
visible month(s), a `•` marks days with a note) opening `JournalDay` inline.

Key findings / deviations:
- **RN-render tests are NOT done in vitest here** — the mobile vitest env is `node` with no RN
  preset (the config comment: "Broader runtime coverage is the Maestro flow"). So the automatable
  J5 test is `apps/mobile/test/hermes-compat.test.ts` — the **CI-greppable no-`Intl.Segmenter`
  guard** across core+ui+mobile `src`. `truncatePlain`'s doc was reworded so the guard is a clean
  bare grep. Editor/preview/emoji RENDER verification is the manual/Expo-Go checklist below
  (matches the plan's inherently-manual DoD).
- **Full archive stays web/desktop-only** (mobile = single-day Share only), per D7 — the RN
  document-picker/zip hand-off is deferred exactly like §13 import was.
- **Deps:** `react-native-markdown-display`@^7.0.2 (peer deps satisfied by React 19 / RN 0.79).

Parity checklist (✅ = code/gate-verified here; ☐ = needs a device/human — Expo Go, Maestro, or
Tauri dev build; NOT gate-blocking):
- ✅ Mobile create/edit/delete wired (`writeJournal`/`deleteJournal` via `useCommands`; same
  overlay + D5 path as web — server/store tests already cover convergence).
- ✅ Offline write shows immediately (overlay) → syncs on reconnect — the S7-F6 overlay semantics
  are exercised by J3's real-store tests; the mobile path reuses the identical store.
- ✅ Toolbar/emoji-safety logic shared with web (`applyMarkdownEdit`, ui-tested incl. the ZWJ
  corpus); no `Intl.Segmenter` (greppable test).
- ☐ Emoji corpus RENDERS on iOS + Android (native keyboards → TextInput → markdown preview) via
  Expo Go / dev build.
- ☐ Offline→reconnect end-to-end on a real device (Maestro flow in `.maestro/`).
- ☐ Desktop (Tauri = the J4 web build): WebView2 renders color emoji with the `--px-font` stack,
  and the Settings `.md` archive download lands via the WebView2 download path. (The web prod
  build is verified in J4; the Tauri shell is the same bundle.)

### J6 — E2E, fresh-device lazy-load proof, docs, release
`apps/web/e2e/journal.spec.ts` (workers:1 in CI; rerun failures at low concurrency locally):
1. Create a note with markdown + `'👨‍👩‍👧‍👦'` on a day → reload → exact content; edit →
   converges; delete → dot gone.
2. **Lazy-load proof:** seeds hold notes in two past months (J1 seed, explicit
   schema_version). Fresh browser context + login → land on Agenda → page-eval the local
   PowerSync db (existing spec helper pattern): `journal_entries` count for the seeded months
   is 0 (current month may hold only its own rows). Navigate to seeded month A → its rows
   appear; month B still absent. Navigate B → appears.
3. Offline scenario (context.setOffline): write on a day, go online, assert single row + no
   ghost after two devices' same-day writes (reuse the two-context pattern from v14.spec).
4. **Export proof (D7, ties to the lazy-load proof):** in the SAME fresh context as (2) —
   before visiting the seeded months — trigger the Settings archive export; Playwright
   `download` event → read the zip (`fflate.unzipSync`; add fflate to apps/web devDeps for
   the spec) → assert it contains exactly the seeded days at `journal/YYYY/YYYY-MM-DD.md`
   with byte-exact content, INCLUDING months never viewed locally. Also: day-panel export of
   the emoji note from (1) downloads `YYYY-MM-DD.md` matching what was typed.

Docs + release:
- `docs/SELF_HOSTING.md` upgrade notes: migration 0010 changes the publication ⇒ **restart
  the PowerSync container after migrating** (Surface Go prod: this rides the same upgrade
  that runs 0009).
- ARCHITECTURE annex: journal section (D1–D7 distilled), stream-parameter invariant,
  journal-export endpoint in the API surface table.
- CI: no new jobs; e2e spec joins the existing Playwright job.
- Merge PR `journal` → `main` with all jobs green; update memory per-session records.

**DoD:** all gates + e2e green in CI; fresh-device proof is an asserted test, not a claim.

#### J6 — AS BUILT (2026-07-04) → **DONE.** `apps/web/e2e/journal.spec.ts` (3 tests) runs GREEN
against the live WSL stack:
1. create (markdown + `👨‍👩‍👧‍👦`) → server-persist → reload keeps it → edit converges → delete
   (dot gone); the day-panel Export .md downloads exactly the typed content.
2. **FRESH-DEVICE LAZY-LOAD PROOF (asserted, not claimed):** a note seeded in a past month
   (`daysAgo(42)`) is `localCount(page, pastA) === 0` after login+Agenda (its month never
   subscribed), while today's note IS local; navigating 6 weeks back subscribes the month →
   `localCount === 1`. Page-evals the local replica via `window.__db` (App.tsx exposes it under
   `import.meta.env.DEV`).
3. The Settings `.md` archive (server-sourced) contains the never-synced past month.
4. Offline (`context.setOffline`) write shows immediately (overlay), syncs on reconnect, one row.

Notes:
- **Ran it locally to verify** (the DoD's "asserted, not a claim"). Recipe on THIS machine:
  server `start` with `POWERSYNC_JWT_SECRET=<dev>` + `PS_JWT_K_B64URL=<base64url(dev)>` (the
  committed .env's prod `PS_JWT_K_B64URL` would trip the S10-F5 boot check) +
  `BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173` + `PRISMS_JOBS_ENABLED=false` +
  `DATABASE_URL=…@127.0.0.1:5434/…`; web `dev` with `VITE_POWERSYNC_URL=http://localhost:8081`;
  then `playwright test journal.spec.ts --workers=1`. MUST be the DEV server (not `vite preview`)
  so `__db` is exposed. Vite proxies `/api`+`/sync` → :3001.
- The plan's "two-context pattern from v14.spec" does not exist (v14.spec is M12, single-context;
  no e2e uses `newContext`). Two-device same-day convergence is proven deterministically at the
  store (journal-overlay) + server (journal.integration) level; the e2e offline test covers the
  single-device overlay→sync path.
- **Docs:** `docs/SELF_HOSTING.md` — migration-0010 publication note (restart PowerSync) + the
  Sync-Streams row now names `journal_month` + the narrow-only parameter invariant. `ARCHITECTURE.md`
  — new **Annex J** (D1–D7 distilled + stream-param invariant + `/sync/journal/export`), added as
  an appendix (the frozen v1.0 §6/§8 bodies left untouched, per the J1 decision).
- CI: no new jobs — the spec joins the existing Playwright job (config already `workers:1` on CI).

### J7 (optional, post-merge) — WYSIWYG on web/desktop
TipTap + `tiptap-markdown` bound to the same `content` field (markdown in/out; storage format
unchanged — mobile keeps the J4 toolbar editor). Interactive task-list checkboxes. Separate
branch/PR; no schema or server changes by construction.

---

## Risk register
| Risk | Session | Mitigation |
|---|---|---|
| Parameterized streams unsupported/buggy on service 1.22.0 | J0 | ✅ CLEARED at J0 — compiled + ACTIVE with a `month_key`-partitioned bucket on 1.22.0; fallback not needed (kept in D3 as insurance). Client-delivery/TTL/offline re-proof carried to J3/J6 |
| Publication omission ⇒ silent no-sync | J1 | Migration reviewed against R10 pattern; J6 e2e would catch (rows never arrive) |
| Ghost overlay on two-device same-new-day | J2/J3 | D5 ack-effects rewrite + convergence tests (also hardens tag.answer) |
| Losing a paragraph to LWW silently | J2 | hlc_conflict review item carries losing content |
| Emoji mangling via UTF-16 slicing | J4/J5 | `truncatePlain` code-point helper; corpus tests at every layer; no Intl.Segmenter (Hermes) |
| Markdown XSS | J4/J5 | No raw HTML render path; href scheme allowlist; hostile-input component tests |
| Tombstones never purged | J2 | PURGE_ORDER entry + retention test |
| e2e seeds missing schema_version | J1/J6 | Seeds carry it explicitly (0f6b95d) |
| "Export all" from a partial local replica silently truncates | J2/J4 | D7: archive sources from the server endpoint, never local; J6 e2e asserts never-viewed months appear |
| Zip mangles emoji bytes | J3 | Verbatim UTF-8 via TextEncoder; corpus round-trip `buildJournalArchive`→`unzipSync` unit test |
