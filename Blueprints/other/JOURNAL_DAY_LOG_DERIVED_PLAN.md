# Journal Day Log — Build Plan (V1–V5)

**Feature:** a built-in automation that shows, on every journal day page, a **read-only,
system-generated "Day log" footer** listing that day's **scheduled tasks** (committed
agenda blocks) and **completed tasks**. The footer renders under the note editor on
web/desktop/mobile and is appended to the `.md` exports. It is **optional and ON by
default**, toggled from Automations → Built-in. The user can never edit it — not as a
UI restriction but **by construction**: the log is a pure function of facts that already
exist, computed at read time. **Nothing is stored, so there is nothing to edit.**

**Branch:** `feat/journal-day-log` off `main`. One commit per session (house rule).

**Gate per session:** `pnpm turbo lint typecheck test` (all 21 packages) + `@prisms/core
test:coverage` ≥ 90 floor. Integration tests need the dev stack up (`wsl docker compose
up -d`) and `PRISMS_DB_TEST_URL` pointing at `127.0.0.1:5434` — connect on the IP, not
`localhost`. V5 adds the web Playwright e2e vs the live stack. Merge the PR at V5 with
CI green.

**No spike session.** Everything this feature touches is already runtime-proven: the
facts it reads are the bootstrap-tier tables every device already holds, the flag rides
the existing `user_settings` row, and the compute is plain pure TS exercised by the same
harnesses as `useWorklist`/`useDoneToday`.

---

## Why derived, not materialized (decision record — do not re-litigate)

The obvious alternative is a synced `journal_day_logs` table written by the server (and
mirrored optimistically by clients) whenever a fact changes. It was considered and
rejected. The reasons, in order of weight:

1. **Clients already hold every fact the log needs.** The `bootstrap` stream syncs ALL
   live `nodes` and ALL live `schedule_blocks` with no age window
   (`packages/db/sync-streams.yaml:38-40`), and the warm `FactContext`
   (`packages/ui/src/hooks.ts:285` — built once per session by `PrismsDataProvider` over
   the overlay-MERGED rows) is exactly the input the computation wants. `useDoneToday`
   (`hooks.ts:999`) already derives "tasks completed today" this way, from the same
   provider, using the same `bucketDate` idiom.
2. **The log's semantics are a snapshot of current facts, not history** (D2): unchecking
   a task removes its line, renaming updates the title, deleting erases it from every
   day. A table with those semantics stores nothing derivation loses — it is a pure
   cache, and it costs a per-command server writer, a client optimistic mirror,
   deterministic-id convergence, a reverse-lookup index for old-day correction, a
   backstop sweep job, tombstones, purge/restore ordering, and a stream change.
3. **Derivation is *more* correct in two places.** Offline-instant updates come free —
   the overlay merge already patches the facts the computation reads, so a pending
   offline `node.check_off` shows in the footer with zero write code. And a
   timezone/day-reset change re-buckets **every** day consistently at next render,
   instead of leaving untouched historical rows stale under the old settings.
4. **Costs accepted:** a memoized O(live nodes + blocks) pass per viewed day — cheaper
   than `useWorklist`, which does comparable work on every 1-second tick, because the
   footer depends on `date`, not `now`, and so never recomputes on the clock. And IF
   live facts are ever age-tiered off devices, old days stop being derivable — that is
   the trigger to materialize (D9), not a reason to pre-build it.

---

## Design decisions (normative for all sessions)

### D1 — No table, no writers: the day log is a pure read
`computeDayLog(facts, date, settings) → DayLogEntries | null` (null = empty day) lives
in `@prisms/core` and is evaluated in exactly two places:

- **Client, at render:** a `useDayLog(date)` hook over the warm merged facts (D5).
- **Server, at export:** the journal archive job composes logs per day (D6).

Consequences, all deliberate:
- **Zero write-path surface.** No new table, no publication change, no `journal_month`
  or `history` stream change, no dispatcher refresh pass, no client optimistic writer,
  no backstop job, no tombstones, no `PURGE_ORDER`/`RESTORE_ORDER`/backup-snapshot
  entries, no convergence or reconcile machinery. `ROW_SCHEMA_VERSION` stays 1; core
  `entitySchemas` stays frozen at 22; the client `appSchema` stays at 23 synced tables;
  the fresh-DB table-list test stays at 32.
- **Not editable, structurally:** there is no stored artifact to address. The UI renders
  the computed entries outside the editor (D7); no command touches anything.
- **Two devices can never disagree** about the footer except by holding different facts
   — ordinary sync lag, already resolved by the existing machinery.

**Rejected alternatives**, so they are not revisited:
- *A generated column or marker block inside `journal_entries.content`* — user-editable
  by definition; breaks the verbatim-content export contract (D7); whole-content
  last-write-wins would merge user prose with system text.
- *A boolean/JSON column on `journal_entries`* — pushes system writes through the user
  LWW arbiter, lights the Agenda note-dot for every day that merely has tasks, and
  reduces "not editable" to a UI promise.
- *A seeded `automation_rules` row* — that grammar is trigger→spawn_task with rule
  versioning and drift machinery; a derived read does not fit it, and a phantom rule
  would leak into rule CRUD, replay, and drift audits. The flag lives in settings; the
  *presentation* lives on the Automations screen (D8), which is what "make this
  automation optional" means to the user.

### D2 — Semantics
`DayLogEntries = {v: 1, scheduled: […], completed: […], truncated?}`:

- **scheduled[]** `{ block_id, task_id, title, starts_at, ends_at, done }` — live
  committed blocks (`status = 'committed' AND superseded_at IS NULL AND deleted_at IS
  NULL`) whose `starts_at` buckets to the day (D3), joined to their live node.
  `done = node.completed_at !== null` (live, any day). Suggested and superseded blocks
  never appear.
- **completed[]** `{ task_id, title, completed_at, disposition, planned }` — live nodes
  (any completable type; in practice task/activity) whose `completed_at` buckets to the
  day. `disposition` is carried through (`'obsolete'` renders as "descoped", D7).
  `planned` = the task had a committed live block bucketed to that same day.
- **Ordering is deterministic:** scheduled by `(starts_at, block_id)`, completed by
  `(completed_at, task_id)`. Cap 100 per list; overflow recorded as
  `truncated: {scheduled: n, completed: n}` and rendered "+N more" — determinism over
  completeness.
- The log always agrees with what the Agenda and the status index say about that day.
  Unchecking, renaming, deleting, and cross-day block moves are reflected at the next
  render: that IS the feature, not a side effect to engineer around.

### D3 — Day assignment: `bucketDate`, nothing else
`bucketDate(instant, day_reset_hour, timezone)` (`packages/core/src/time/bucket.ts`) is
the single day-assignment rule for the whole codebase, and this feature adds no second
one: blocks belong to the day of `starts_at` (a block crossing the reset hour stays on
its start day), completions to the day of `completed_at`. Settings come from the merged
`user_settings` at compute time; a missing row falls back to the architecture defaults
(`day_reset_hour` 4, timezone `America/New_York` — mirrored by `useUserSettings`,
`hooks.ts:1297`). Changing timezone or day-reset re-buckets **all days at the next
render**. Documented in Annex L (V5), not fought.

### D4 — Toggle: `user_settings.journal_day_log`, default TRUE
One boolean, threaded through every **explicit field list** on the settings path. Each
list is a place where the flag silently dies if forgotten, so each ⚠ below is a named
test target, not a note:

- `packages/db/src/schema.ts` + migration `0012`: `ALTER TABLE user_settings ADD COLUMN
  journal_day_log boolean NOT NULL DEFAULT true` — existing users get it ON.
- ⚠ **`packages/db/sync-streams.yaml:37`** — the bootstrap `user_settings` query is an
  EXPLICIT column list, not `SELECT *`. Omit the column and clients never receive the
  flag and the toggle is permanently stuck at its client-side default. Top gotcha.
- `packages/core/src/commands/settings.ts:13` — `settingsUpdateSchema` gains
  `journal_day_log: z.boolean().optional()`; the `UserSettings` entity and its defaults
  in `domain/entities.ts` follow.
- ⚠ **`apps/server/src/dispatcher.ts:1502-1505`** — the `settings.update` handler builds
  its LWW `candidate` object from an explicit `if (p.x !== undefined)` list. Omit the
  flag and `settings.update {journal_day_log}` applies as a silent no-op.
- ⚠ **`packages/ui/src/powersync/effects.ts:360-363`** — the optimistic `settings.update`
  effect has the same explicit field list. Omit it and the toggle only takes effect
  after the server round-trip, which breaks the V5 offline-toggle e2e.
- Client: the `user_settings` Table (`packages/ui/src/powersync/schema.ts:284`) gains
  `journal_day_log: column.integer`; `toUserSettings` maps SQLite 0/1 with **absent ⇒
  true**; `useUserSettings` (`hooks.ts:1297`) exposes `journalDayLog`.

**OFF** ⇒ `useDayLog` returns null (footer hidden on every surface) and exports omit the
section and the log-only days. **ON** ⇒ the footer renders. There is no catch-up
machinery, no retained rows, and no flip semantics to design: it is conditional
rendering over a recomputation.

Mobile has no Automations screen — it obeys the synced flag; the toggle is
web/desktop-only (recorded in the V5 parity checklist).

### D5 — Client read path: the warm provider, nothing new
`useDayLog(date: IsoDate): DayLogEntries | null` in `packages/ui/src/hooks.ts`:
`usePrismsData()` supplies nodes via `ctx.tree.byId`, blocks via `rows.schedule_blocks`,
and settings via the merged `user_settings` row; the body is
`useMemo(() => computeDayLog(…), [rows.schedule_blocks, ctx, date])`. `useDoneToday`
(`hooks.ts:999`) is the template — same provider, same bucketing idiom, minus the `now`
dependency. Properties, all free:

- **Offline-instant:** the provider's rows are overlay-merged, so a pending offline
  `node.check_off` patches the facts before the memo re-runs — the footer updates in the
  same render pass, with zero new write code.
- **Every mutation path is covered by construction.** A completion written by the timer
  review path (`dispatcher.ts:949` writes `nodes.completed_at` through `lwwFields`),
  automation-spawned rows, a restored import — anything that changes the replica or the
  overlay changes the memo's inputs. There is no per-verb collector to keep in sync with
  the command set, and therefore no verb coverage matrix to maintain.
- **No sync footprint:** the footer computes from bootstrap-tier facts, so it works even
  for a day whose month was never subscribed. (The *note* still needs its month held;
  the journal surfaces already hold the visible months.)
- `streams.ts`, `execute.ts`, `upload-commands.ts`, and `overlay-store.ts` are
  **untouched** — only `effects.ts` changes, and only for the D4 settings field.

### D6 — Server read path: export-time compose
`runJournalExport` (`apps/server/src/jobs/journal-export.ts`, served at
`GET /sync/journal/export`, `apps/server/src/app.ts:167`) grows from one select to three:
live notes (as today) + live completed nodes + live committed blocks, plus the user's
`user_settings` row for the flag, timezone, and day-reset hour. When the flag is on, a
single-pass `computeDayLogsByDate` (V1) groups all facts by `bucketDate` and:

- response entries gain optional `day_log: DayLogEntries`;
- days holding ONLY a log and no note are included as `{entry_date, content: '',
  day_log}` — the archive shows what the journal shows.

This is an additive response change; old clients ignore the field, and with the flag off
the response is byte-identical to today's. `requireSession` and the rate gate are
untouched.

The export stays **server-sourced on purpose**: under the lazy month-bucketed
`journal_month` stream a device may hold only the months it has viewed, so a client-side
"export all" would silently truncate. The server ships structure, never rendered
markdown — the client composes the `.md` bytes (D7) with the same core function the UI
uses, so the two can never drift.

### D7 — Rendering: structured in memory, rendered per surface
- The computed `DayLogEntries` is **never markdown at rest**. The UI renders React/RN
  views from the entries; exports render markdown. One pure core module owns both
  textual forms: `renderDayLogMarkdown(entries, {timezone})` and
  `composeDayMarkdown(content, entries | null, {timezone})`.
- A day's `.md` is its `content` field **verbatim** — the date lives in the filename, no
  frontmatter, byte-lossless including emoji (`packages/ui/src/portability/journal-md.ts`).
  `composeDayMarkdown` preserves that: `content`, then `\n\n---\n\n### Day log\n`, then
  the rendered section, appended only when the flag is on and the log is non-empty.
  `content` is always a verbatim prefix of the result (property-tested in V1). The `.md`
  is an export-only format — nothing imports it — so appending is safe, and the
  deterministic separator would let a future importer strip the section.
- Times render `HH:mm` in the user's timezone via a `formatDayLogTime` built on the
  `localParts`/`localInstant` machinery already in `time/bucket.ts` — no
  `Intl.Segmenter` (the Hermes rule enforced by the mobile grep guard), no new Intl
  dependence. `'obsolete'` renders "descoped"; `planned: false` renders "(unplanned)";
  `done` renders as a checked box in the Scheduled list.
- The footer NEVER enters the TipTap document or the mobile `TextInput` — it is a
  sibling component below the editor/preview. That, plus D1's nothing-is-stored rule,
  is the entire "not editable" enforcement story.

### D8 — Surfaces
- **Web/desktop:** `DayJournalPanel` (`apps/web/src/components/DayJournal.tsx:50`) gains
  a `DayLogFooter` below the editor and below the `MarkdownView` preview;
  `screens/Journal.tsx`'s day view gains the same footer (it is expected to share the
  panel — verify in V4). Styling per the standing design rules: light,
  Linear/Akiflow-adjacent, a muted "Generated · updates automatically" caption, NO
  purple/pink gradients.
- **Automations screen** (`apps/web/src/screens/Automations.tsx:13`, the `TABS` array): a
  third hash tab `built-in` beside Rules and Blockers, hosting a "Journal day log" card
   — description plus a toggle wired to `settings.update {journal_day_log}`, optimistic
  via the D4 effects entry, reflecting the live merged settings row.
- **Mobile:** `apps/mobile/src/screens/JournalDay.tsx` renders the footer below the
  editor/preview; its `share()` (line 94) switches to `composeDayMarkdown`. No toggle UI.
- **Exports:** the day `.md` (web panel download + mobile Share) composes from local
  facts via `useDayLog` + `composeDayMarkdown`. The archive
  (`fetchJournalExport`/`downloadJournalArchive` in `apps/web/src/portability.ts` +
  `buildJournalArchive` in `packages/ui/src/portability/journal-md.ts`) carries `day_log`
  per D6, and the client composes each file with the same core function.

### D9 — If devices ever stop holding old facts: snapshot at compaction time
One condition breaks this design: age-tiering *live* archival data off devices. The
`sync-streams.yaml` header (lines 23-29) records this as deferred Annex A5 — PowerSync
buckets do not re-evaluate a time predicate as rows age, so age-based archival needs a
materialized `archived` flag maintained by a job plus client lazy-subscription wiring.
If that ships, days whose facts have aged out stop being derivable on-device.

The response then is **not** a live materialized cache. Only *aged-out* days are
affected — today and recent days derive fine, because their facts are the working set by
definition — and an aged-out day is by definition immutable. So the fix is a
compaction-time snapshot: the same job that archives a day's facts writes one row
holding that day's `computeDayLog` output, written once and never updated; if a fact is
ever un-archived, that job deletes the snapshot and the day returns to derivation. No
optimistic client writer, no per-command in-transaction refresh, no reverse-lookup
index — those exist only to keep a *live* cache correct, and live days are never
materialized. `computeDayLog` is unchanged and shared by both paths; the snapshot merely
stores its output.

Out of scope for v1. The trigger condition is recorded in Annex L (V5) so whoever builds
age-tiering inherits it. Until then, the facts all live in Postgres and nothing is lost.

---

## Sessions

### V1 — Flag plumbing (db + core) and the pure engine
`packages/db`:
- `src/schema.ts`: `user_settings.journal_day_log` boolean NOT NULL DEFAULT true. **No
  new table.**
- Migration `0012_journal_day_log.sql` (+ drizzle meta/snapshot): the single `ALTER
  TABLE user_settings ADD COLUMN … DEFAULT true`. **No publication change** — the
  `powersync` publication is scoped (empty at initdb, populated by migration 0009), so
  adding a *table* would require altering it; adding a *column* does not.
- `sync-streams.yaml`: add `journal_day_log` to the bootstrap explicit column list
  (line 37) — the D4 top gotcha. Run `check-sync-rules`, then do the live check: the
  changed bootstrap stream compiles and reaches `state=ACTIVE` on the WSL
  powersync-service 1.22.0. A query change is a stream change even with no new table.
- `seed.ts`: seed the V5 export proof — a **past-month** day carrying a committed block
  and a completed task and NO journal note (a log-only day). Every seeded row needs an
  explicit `schema_version`; omitting it makes the dispatcher reject the row as
  `E_CLIENT_TOO_OLD` and the failure surfaces far from its cause.
- Parity tests: `type-assertions.ts` and the schema-baseline / sync-streams expectations
  gain the new column. The fresh-DB table-list assertion **stays at 32** — assert it,
  because that test only runs in CI against a fresh database, so a mismatch is invisible
  locally and fails the branch's first CI run.

`packages/core` (all pure, no wall clock anywhere):
- `commands/settings.ts`: `journal_day_log` optional boolean; `UserSettings` entity and
  `DEFAULT_*` plumbing in `domain/entities.ts`.
- `journal/day-log.ts`: `dayLogEntriesSchema` (zod, the D2 shape);
  `computeDayLog({date, nodes, blocks, dayResetHour, timezone})` — callers may pass
  supersets, the function filters and buckets; `computeDayLogsByDate(facts, settings) →
  Map<IsoDate, DayLogEntries>`, the single-pass grouping the export uses;
  `renderDayLogMarkdown`; `composeDayMarkdown`; `formatDayLogTime`.
- Unit tests: bucket edges (day-reset 4 — a completion at 03:59 vs 04:00 local; DST
  transition days; a block 23:00–01:30 stays on its start day); the
  done/planned/disposition matrix; a determinism property (shuffled input rows produce
  deep-equal entries, including ordering and truncation at the 100 cap); an equivalence
  property (`computeDayLog` for day D equals `computeDayLogsByDate(...).get(D)`); emoji
  titles through compute→render; a markdown render golden; and the compose property
  (`content` is always a verbatim prefix; no footer when entries are null).

**DoD:** gate green; the migration applies on a fresh DB AND on a copy of the populated
dev DB; the bootstrap stream reaches ACTIVE on 1.22.0; zero behavior change anywhere
(the flag exists, nothing reads it yet).

### V2 — Server: settings passthrough + export-time day logs
- `dispatcher.ts:1502-1505`: add `journal_day_log` to the `settings.update` candidate
  list (D4 ⚠). **This is the only dispatcher line the feature touches.**
- `jobs/journal-export.ts` per D6: three selects plus the settings read; flag off ⇒
  current behavior byte-identical; flag on ⇒ `day_log` per day plus log-only days, with
  the existing date ordering preserved.
- `app.ts` route: payload passthrough only — the shape is the job's.

Integration tests (live Postgres via `PRISMS_DB_TEST_URL`):
- Export matrix: flag on and off; the seeded log-only past-month day appears; a day with
  both a note and facts carries both; `done` / `planned` / `disposition` / truncation
  surface correctly; owner-scoped; 401 through the existing HTTP wrapper test;
  soft-deleted, suggested, and superseded blocks excluded; emoji titles byte-exact.
- `settings.update {journal_day_log: false}` round-trips through LWW and persists — this
  test fails if the D4 dispatcher candidate list is missed.
- **Absence audit:** assert by grep that the feature adds no dispatcher write path, no
  job, and no publication entry — the D1 claim as a test rather than narration.

**DoD:** gate green; the flag-off export response is byte-identical to main's (golden
comparison).

### V3 — Client: settings plumbing + `useDayLog`
`packages/ui`:
- `powersync/schema.ts:284`: the `user_settings` Table gains `journal_day_log:
  column.integer`. The synced-table count is unchanged at 23 — check any schema snapshot
  asserting the column list.
- `powersync/rows.ts`: `toUserSettings` maps 0/1, absent ⇒ true.
- `powersync/effects.ts:360-363`: the D4 optimistic field (⚠).
- `hooks.ts`: `useUserSettings` gains `journalDayLog`; new `useDayLog(date)` per D5.

Tests (real better-sqlite3 store, the existing client harness):
- Offline `node.check_off` ⇒ `useDayLog(today)` reflects it in the same render pass
  (overlay-merged input, no writer); uncheck ⇒ the line is gone; a cross-day
  `block.move` ⇒ both days compute correctly.
- Flag off ⇒ null; an optimistic `settings.update {journal_day_log}` flips the output
  with no round-trip — this test fails if the `effects.ts` ⚠ is missed.
- A completion written through the timer review path surfaces in the footer, proving the
  no-verb-knowledge claim of D5.
- Fuzz: malformed or absent fact fields never throw — the compute is total over dirty
  rows.

**DoD:** gate green, plus an explicit assertion that `execute.ts`, `upload-commands.ts`,
and `overlay-store.ts` are untouched (D5) — the diff is the proof; note it in the commit
message.

### V4 — Web UI + exports
- `components/DayJournal.tsx`: a new `DayLogFooter` below the editor AND below the
  Preview — sections "Scheduled" (read-only checkbox glyphs, times) and "Completed"
  (times, "(unplanned)", "descoped"), truncation as "+N more", and the muted generated
  caption; hidden when the flag is off or `useDayLog` returns null. Rendered **outside**
  `RichJournalEditor`; nothing in it is focusable or editable.
- `screens/Journal.tsx`: the same footer on its day view (shared panel expected — verify;
  if it renders its own day body, mount `DayLogFooter` there too).
- `screens/Automations.tsx`: a third `TabSpec` `built-in` → the "Journal day log" card
  (what it does, toggle → `execute('settings.update', {journal_day_log})`).
- Exports: the day-panel download composes `composeDayMarkdown(content, useDayLog(date))`;
  `portability.ts` passes `day_log` through; `buildJournalArchive` accepts entries with
  an optional `day_log` and log-only entries, composing each file with the same core
  function.
- `theme.css`: `.px-daylog*` styles per the standing design rules.
- Component tests (the jsdom `createElement` pattern; mock `@prisms/ui` hooks via
  `importOriginal`): the footer renders the full marker matrix; **the footer subtree
  contains NO input, textarea, contenteditable, or button** — the editability regression
  test; flag-off hides it; the toggle card dispatches `settings.update`; the day export
  blob is the typed content verbatim plus the `### Day log` section; the archive zip
  contains the log-only day's file.

**DoD:** gate green; a manual look on Windows Chromium and the Tauri dev build
(checklist, not gate-blocking).

### V5 — Mobile parity, e2e, docs, release
**Mobile (Expo RN):**
- `screens/JournalDay.tsx`: the footer below the editor/preview — plain RN views from the
  same `useDayLog` entries (shared hook, shared provider, no markdown detour), using
  `formatDayLogTime` so the no-`Intl.Segmenter` grep guard stays green; `share()` (line
  94) switches to `composeDayMarkdown`. The Agenda day-picker dot stays
  `journal_entries`-only, so a log-only day gets no dot.
- The mobile vitest environment is node — no RN render tests; the pure logic is covered
  in core and ui. Parity checklist (☐ = device/human, non-blocking): ☐ footer renders on
  iOS and Android; ☐ an offline check-off updates the footer on device; ☐ Share carries
  the Day log section. Recorded: the toggle is web/desktop-only (D4).

**`apps/web/e2e/daylog.spec.ts`.** The suite drives one shared live stack, so it is
serial on CI (`workers: 1` — already the config default when `CI` is set) and assumes:
compose postgres + powersync up, `apps/server` on `:3001` with
`BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173`, and the web dev server on `:5173`.
Locally you must shell-override the prod `POWERSYNC_JWT_*` values from `.env` with the
dev ones and build/serve web with `VITE_POWERSYNC_URL` pointing at `:8081`. The
established spec mechanics to reuse from `e2e/journal.spec.ts`: register a fresh user
per test, seed facts by POSTing command envelopes to `/sync/upload` (each envelope needs
`id`, `name`, `hlc`, `payload`, `schema_version: 1`), read the local replica by
page-evaluating `window.__db` (exposed behind a localhost guard in `App.tsx`), read
server truth via `page.request.get('/sync/journal/export')`, and toggle connectivity
with `context.setOffline`.

1. Schedule a task into today and complete it → open today's journal → the footer shows
   it as Scheduled `[x]` AND Completed; uncheck → the footer updates live.
2. Offline (`context.setOffline(true)`): complete another task → the footer updates
   instantly; reconnect → the footer is unchanged, and a page-eval confirms no day-log
   rows exist anywhere in the local replica — asserting D1 structurally.
3. Toggle off in Automations → the footer disappears immediately (optimistic effect);
   toggle on → it reappears including everything completed while it was off. There is no
   catch-up machinery to prove; it is a recomputation.
4. Exports: the day-panel `.md` download is the typed note verbatim plus `### Day log`;
   the Settings archive zip contains the seeded **log-only past-month** day at
   `journal/YYYY/YYYY-MM-DD.md` — server-sourced, its month never viewed, extending the
   existing lazy-load proof to day logs.

**Docs + release:**
- `docs/SELF_HOSTING.md` upgrade notes: migration 0012 adds a settings column only and
  makes no publication change, but the bootstrap stream *query* changed, so **restart
  the PowerSync container after deploying the new `sync-streams.yaml`**. No new jobs, no
  new environment variables.
- `Blueprints/ARCHITECTURE.md`: a new **Annex L — Journal day log** distilling D1–D9 —
  the derived read, the flag, the export compose, the D3 re-bucketing behavior, and the
  D9 trigger condition for age-tiering. Place it after `Annex J — Journal (day notes)`
  (line 653), the only annex there today; annex letters are mnemonic, not sequential
  (J = Journal, L = Log). Appendix only; the frozen v1.0 body stays untouched.
- CI: no new jobs; the spec joins the existing Playwright job.
- Merge `feat/journal-day-log` → `main` with all jobs green; update the memory
  per-session records.

**DoD:** all gates plus e2e green in CI; the non-editability claim is *asserted* (no
input surfaces in the footer subtree, no stored artifact, no command path), not narrated.

---

## Risk register
| Risk | Session | Mitigation |
|---|---|---|
| Bootstrap column list omits the flag ⇒ toggle dead on clients | V1 | explicit stream-yaml step + V3 test that a flag flip reaches the merged client row |
| Dispatcher candidate list omits the flag ⇒ toggle never persists | V2 | one-line D4 change + an integration test on the round-trip |
| `effects.ts` field list omits the flag ⇒ toggle waits for the round-trip | V3 | one-line D4 change + optimistic-flip test + e2e step 3 |
| Bootstrap query change deployed without a PowerSync restart | V5 | SELF_HOSTING note; the V1 live ACTIVE check catches it in dev first |
| Recompute cost on large fact sets | V3 | memoized on `[rows.schedule_blocks, ctx, date]` with no `now` dependency — same cost class as `useWorklist`/`useDoneToday`, which run per tick today |
| Footer editable through TipTap or the RN input | V4/V5 | rendered outside the editor; component test asserts no interactive elements; nothing is stored to edit |
| Export response shape breaks old clients | V2 | additive optional field; flag-off golden byte-comparison |
| UI and archive renderings drift apart | V1/V4 | one core `composeDayMarkdown` used by both; compose golden + zip content tests |
| Timezone/day-reset change re-buckets history at render | D3 | deliberate — it is the correct answer; documented in Annex L |
| Age-tiering later removes old facts from devices | D9 | trigger condition recorded in Annex L; the response is a compaction-time snapshot of immutable aged-out days, not a live cache; facts remain in Postgres so nothing is lost |
| Dirty fact rows (nulls, malformed timestamps) crash the compute | V1/V3 | the compute is total (invalid rows filtered); fuzz tests in both harnesses |
| Fresh-DB table-list CI assertion drifts | V1 | this design adds no table — assert it stays 32 in the same commit as the migration |
