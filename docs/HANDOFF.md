# Handoff — state of the repo on 2026-11-18

For the next LLM (or person) picking this up. Read this first, then `README.md`.
Written at `main` = `80b532d` (PR #45); updated for `fab34dc` (PR #43). Everything below was verified that day.

---

## 1. Where things live (this changed on 2026-11-17/18 — read carefully)

| What | Path |
|---|---|
| **The live repo (work here)** | `C:\dev\Prisms_alpha\prisms` (checkout, on `main`) |
| Extra git worktrees | `C:\dev\Prisms_alpha\prisms-wt\*` (`inbox-assign`, `inbox-complete`, `today-row`) |
| Desktop shortcut | `C:\Users\Flore\Desktop\Prisms.lnk` → `scripts\prisms-stack.ps1` in the live repo |
| Launcher state + logs | `C:\Users\Flore\.prisms\dev-stack\` (`logs\launcher.log`, `api.log`, `web.log`) |
| WSL clone used ONLY to build the Android APK | `~/dev/prisms` inside Ubuntu (its `origin` = `/mnt/c/dev/prisms`) |
| Rescue copies of lost files | `C:\dev\prisms-onedrive-salvage\`, branch `wip/onedrive-uncommitted-2026-11-18` |

**Do NOT work in `C:\Users\Flore\OneDrive\Documents\Claude\Projects\Prisms_alpha`.** On 2026-11-17 (~20:27) OneDrive
wiped most of that checkout (git unreadable). It later came back rolled back to an old branch
(`feat/threshold-brand`) with ~40 `*-Trinity.*` conflict copies. Everything of value was migrated to
`C:\dev\Prisms_alpha\prisms`. A Claude Code session started in the OneDrive folder will even offer to open
PRs from it — ignore that. It is safe to delete once nobody needs it. Old worktrees under
`C:\Users\Flore\.prisms\worktrees\` are likewise obsolete (their `.git` pointers target the dead OneDrive repo).

`.env` (gitignored, in the live repo root) holds only dev port overrides: Postgres **5434**, PowerSync **8081**,
compose API stub **3002** (the *real* API runs on the host at **3001**; the compose `api` container only answers
`/health`). A copy of the old prod-ish `.env` is `.env.onedrive-backup` (gitignored). A fresh worktree has no `.env`:
copy it from the main checkout.

Memory for Claude Code sessions opened in the live repo: `C:\Users\Flore\.claude\projects\C--dev-Prisms-alpha-prisms\memory\`
(index: `MEMORY.md`).

## 2. Running it

- **One click:** double-click the Prisms desktop shortcut. It starts WSL/Docker → Postgres → migrations → PowerSync →
  host API (:3001) → builds and serves the web app (:5173). ~65 s cold. Verified 2026-11-18.
  - The launcher is **single-instance**: a stale launcher window swallows new double-clicks and keeps using its old
    path. Kill `prisms-stack` pwsh/conhost processes first (`scripts\prisms-stack.ps1 -Stop` does most of it).
  - It **rebuilds the web app at every launch**, but the API does **not hot-reload** — after pulling new server code,
    restart the stack. `E_UNKNOWN_COMMAND` on a new verb = stale API.
- **Restarting from a script** (what every session did): `-Stop`, close leftover launcher processes, then
  `explorer.exe "$HOME\Desktop\Prisms.lnk"` (launch it the way the desktop does), and read `launcher.log` for
  `phase up`.
- **Browser:** `http://localhost:5173` (IPv6 `localhost`; `127.0.0.1:5173` does not answer).
- If the page is **blank** in a browser that once ran `pnpm dev`: leftover dev service worker. PR #38 makes the build
  self-heal it; hard-reload once.
- **Testing on side ports** (so you do not disturb the user's stack): run a second API on :3011 and a `vite preview` on
  :4174 with a TEMPORARY `vite.side.config.ts` / `playwright.side.config.ts` (never commit them), shell-override the
  PowerSync JWT env (`POWERSYNC_JWT_SECRET/KID/AUDIENCE`, `PS_JWT_K_B64URL`) with the dev values, and build web with
  `VITE_POWERSYNC_URL=http://localhost:8081`. Details: memory files `dev-stack-on-this-machine.md`,
  `prisms-roadmap-flow-build.md`.

## 3. Verification baseline (all green on 2026-11-18)

`pnpm turbo lint typecheck test` → 21/21 tasks. Per package: core 694, db 60 (needs live Postgres), server 227
(needs live Postgres + PowerSync), ui 215, web 494, mobile 14. Core coverage gate passes. Web Playwright e2e passes
against a live stack (CI runs it too; locally run with `workers: 1` — parallel workers time out on sync-down, and
failing tests pass when re-run alone with `--last-failed`).

Integration tests need `PRISMS_DB_TEST_URL` (admin connection to the dev Postgres on 127.0.0.1:5434; the dev
password is hardcoded in `docker-compose.yml`) and `PRISMS_POWERSYNC_URL=http://127.0.0.1:8081` from a worktree.

Gotchas: use PowerShell (the Bash tool is broken — cygwin fork errors); call tools through `node .../bin` if
`pnpm exec` prints nothing; `git commit` on a OneDrive path prints harmless pack/mmap errors; the built-in browser
pane cannot run the app (no Workers) — verify with Playwright.

## 4. What changed — merged PRs (newest last)

All merged with merge commits into `main`. File lists are `git diff <merge>^1 <merge>`.

### #33 — My Day / Tasks reflow at narrow widths + pentagon project dots
- Screens measure **their own width** (the sidebar rail changes room without a window resize) and pick a layout:
  below 900 px My Day's right rail stacks under the list; below 600 px rows go two-line and buttons lose their text.
- `apps/web/src/list-layout.ts` (new — pure `listLayout(width)`), `apps/web/src/use-measured-width.ts` (new —
  shared ResizeObserver hook; Agenda uses it too), `apps/web/test/list-layout.test.ts` (new)
- `apps/web/src/screens/{MyDay,Tasks,Agenda}.tsx`, `packages/ui/src/theme.css` (`.px-list--stack/--compact` block;
  classes, not `@container`, because the Modal is `position: fixed` and a container would trap it)
- `.px-pdot` (project colour chip) is now a **regular pentagon** via `clip-path` (brand door shape).

### #34 — Capture bar on My Day
- A capture from My Day is an Inbox **activity with `due_date` = today**; Inbox items have no parent so they are not
  in the worklist — they show in a "Captured for today" list under the bar (Assign picker, delete). Promoting keeps id + date.
- `apps/web/src/screens/MyDay.tsx`, `packages/ui/src/powersync/commands.ts` (`createActivity` takes `dueDate`),
  `packages/ui/src/theme.css` (`.px-capture--day`), `apps/web/e2e/myday.spec.ts`.
- No server change (`node.create` already carried `due_date`).

### #36 — Split focus: up to 5 timers at once, logged time split 1/N
- **Rule (I5) changed:** one open entry per *task*, at most `MAX_OPEN_TIMERS` = 5 per user; new error `E_TIMER_LIMIT`.
- **Time split is derived at READ time**, no stored weights: `splitConcurrent` cuts the user's entries wherever the set
  of running tasks changes and tags each fragment with `share = 1/N`; `mergeTimeEntries` weights each instant by it;
  progress / practice / habit-today call it on the user's FULL entry list. Credited minutes always sum to wall-clock.
  Past overlaps between different tasks now split (two golden tests were updated).
- **Core:** `packages/core/src/merge/split-focus.ts` (new), `merge/time-entries.ts`, `aggregates/{progress,practice,today}.ts`,
  `commands/{invariants,timer-merge}.ts` (`checkClockIn(task, id, openTaskIds[])`, generalized §7.4 merge),
  `domain/errors.ts`, `index.ts`; tests under `packages/core/test/`.
- **DB:** `packages/db/migrations/0015_split_focus_timers.sql` widens the `entries_open` partial unique index to
  `(user_id, task_id)`; `packages/db/src/schema.ts`, `migrations/meta/_journal.json`.
- **Server:** `apps/server/src/dispatcher.ts` (`timer.clock_in`), `apps/server/test/dispatcher.integration.test.ts`.
- **UI:** `packages/ui/src/hooks.ts` (`useRunningTimers`; `useRunningTimer` now = latest of them),
  `packages/ui/src/powersync/execute.ts` (client-side guard), `apps/web/src/components/Timers.tsx` (new —
  `TimersProvider`: the switch-or-split dialog + queued focus reviews), `GlobalTimer.tsx` (pill shows "+N",
  "Clock out all"), `screens/MyDay.tsx` (a run card per timer with its own Clock out), `App.tsx`, `format.ts`,
  `apps/mobile/src/screens/Today.tsx` (same dialog/queue; verified on the Android emulator).

### #38 — Retire a leftover dev service worker
- Build emits a real `/dev-sw.js` that unregisters itself and reloads (fixes a blank page after `vite dev` → built app
  on the same origin). `apps/web/retire-dev-sw.ts` (new), `vite.config.ts` (plugin + `globIgnores`), `tsconfig.json`,
  `apps/web/test/retire-dev-sw.test.ts` (new).

### #42 — Complete an Inbox item without a project
- Check circle on every Inbox row (Tasks, both views) → dialog: pick a project + "Add & complete", or "Complete as
  unfocused task". An "unfocused task" is simply a **completed `activity` node**. No server change.
- `packages/ui/src/hooks.ts`: `useActivityInbox` drops completed items; `useDoneToday` includes completed activities with
  `unfocused: true`. `apps/web/src/screens/{Tasks,MyDay}.tsx`, `components/UnfocusedTag.tsx` (new), `e2e/tasks.spec.ts`.

### #44 — Wording
- "Promote" → **"Assign"** (Tasks Inbox rows, My Day captured rows, and the text around them); empty capture fields say
  **"Capture task"**. Labels only — test ids (`promote-*`), `promoteActivity` and the `activity.promote` verb are unchanged.
  `apps/web/src/screens/{Tasks,MyDay}.tsx`, `e2e/{tasks,s16}.spec.ts`.
- Playwright matches button names by *substring*: keep the Inbox check button's label free of the item's title.

### #45 — Removed the explainer paragraph under Tasks › By project
- `apps/web/src/screens/Tasks.tsx`, and the unused `.px-expl` rule in `packages/ui/src/theme.css`.

### Other sessions' work that is also on `main` (not described here)
#37/#40 journal tags + clocked-time timeline (migration 0016), #39 long-session review (>6 h item, 24 h auto clock-out,
`timer.adjust`, migration 0017), #41 journal "Today" row, #43 web journal Day log loses its "Generated · updates
automatically" caption (`DayLogFooter.tsx`, `theme.css`, `daylog-ui.test.ts`; mobile still shows it). Their notes: memory files `prisms-journal-tags-clocked.md`,
`prisms-long-session-review.md`.

## 5. Unmerged work (nothing here is lost, nothing is pushed unless stated)

| Branch | What it is | Status |
|---|---|---|
| `fix/day-tasks-resize` (local only, 13 commits past `main`) | Pulsing running-task mark (`RunMark`), top-bar **timezone clock** with a Settings switcher + blinking colon, My Day shows **logged time even with no estimate** ("0h 00m"), solid Clock in/out icons | **Every commit except the icon conflicts** with split focus's rewrite of `MyDay.tsx`, `GlobalTimer.tsx`, `App.tsx`. Needs a hand-port onto current `main`. The user said "not now". |
| `wip/onedrive-uncommitted-2026-11-18` (local) | Snapshot of the OneDrive tree's uncommitted work. Beyond the branch above it adds: **Agenda** today-column highlight + to-do list flowing with the page; **sidebar** scroll-fade (`useScrollFade` in `Layout.tsx`) | Does not apply cleanly to `main`. |
| 39 recovered local-only branches (`docs/stepwise-plan`, `docs/wearables-plan`, `s01…s23`, `r01…r10`, `remediation`, `feat/confirmable-tags`, …) | Old build-session history recovered from the WSL clone | Local only. Push the ones that matter. |
| `refs/old-onedrive/*` | Exact old branch tips from the OneDrive repo | Safety net; can be deleted later. |
| `feat/journal-daylog-no-caption` (worktree `today-row`) | Another session's journal work | Merged as #43; the worktree can be removed. |

Plans (not started): `Blueprints\STEPWISE_PLAN.md` (new Elixir/Phoenix app, separate repo), `Blueprints\WEARABLES_PLAN.md`.

## 6. Open items / next steps

1. **Production (Surface Go, Tailscale) is out of date** — it did not respond over Tailscale on 2026-11-17/18, so
   migrations 0015–0017 and everything above are not deployed there. On the server: `git pull`, then
   `docker compose -f docker-compose.prod.yml up -d --build` (the API applies migrations on start; restart PowerSync
   afterwards). See `docs/SELF_HOSTING.md` and memory `prisms-surface-go-server.md`.
2. Hand-port the `fix/day-tasks-resize` features (above) if the user still wants them.
3. Push the recovered branches worth keeping; delete the obsolete OneDrive folder and old worktrees.
4. The user's Edge profile may still hold a dev service worker for `localhost:5173`; PR #38 clears it on the next load.
5. The user's earlier "blank website" report was never confirmed fixed by them.

## 7. Conventions the user has set

- Light, clean UI; **no purple/pink gradients**; brand = the Threshold pentagon mark (door shapes).
- **Don't push a PR for every commit.** Commit each finished piece locally on a feature branch; push and open a PR
  only after significant work or when the feature is complete (or when asked). Small follow-up tweaks go on the
  current feature branch, not a fresh PR. Wait for CI to be green before merging; use merge
  commits (`gh pr merge --merge --match-head-commit <full sha>`). The repo has no required checks, so GitHub refuses
  auto-merge while CI runs — wait instead of merging early.
- A migration that adds a table must also update the fresh-DB table list in `packages/db/test/integration.test.ts`;
  drizzle silently skips a migration whose `when` timestamp collides with another.
- After merging, fast-forward the live checkout and restart the stack so the user sees the change.
