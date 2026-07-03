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
        AND month_key = subscription.parameters() ->> 'month'   # exact syntax pinned at J0
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
- **Fallback (decided at J0 exit):** if parameterized subscribe fails on the pinned service
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
**DoD:** gate green; manual Win+. emoji входит check on Windows Chromium + Tauri dev build.

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

### J7 (optional, post-merge) — WYSIWYG on web/desktop
TipTap + `tiptap-markdown` bound to the same `content` field (markdown in/out; storage format
unchanged — mobile keeps the J4 toolbar editor). Interactive task-list checkboxes. Separate
branch/PR; no schema or server changes by construction.

---

## Risk register
| Risk | Session | Mitigation |
|---|---|---|
| Parameterized streams unsupported/buggy on service 1.22.0 | J0 | D3 fallback: single lazy `journal` stream; API shaped so only the subscription body changes |
| Publication omission ⇒ silent no-sync | J1 | Migration reviewed against R10 pattern; J6 e2e would catch (rows never arrive) |
| Ghost overlay on two-device same-new-day | J2/J3 | D5 ack-effects rewrite + convergence tests (also hardens tag.answer) |
| Losing a paragraph to LWW silently | J2 | hlc_conflict review item carries losing content |
| Emoji mangling via UTF-16 slicing | J4/J5 | `truncatePlain` code-point helper; corpus tests at every layer; no Intl.Segmenter (Hermes) |
| Markdown XSS | J4/J5 | No raw HTML render path; href scheme allowlist; hostile-input component tests |
| Tombstones never purged | J2 | PURGE_ORDER entry + retention test |
| e2e seeds missing schema_version | J1/J6 | Seeds carry it explicitly (0f6b95d) |
| "Export all" from a partial local replica silently truncates | J2/J4 | D7: archive sources from the server endpoint, never local; J6 e2e asserts never-viewed months appear |
| Zip mangles emoji bytes | J3 | Verbatim UTF-8 via TextEncoder; corpus round-trip `buildJournalArchive`→`unzipSync` unit test |
