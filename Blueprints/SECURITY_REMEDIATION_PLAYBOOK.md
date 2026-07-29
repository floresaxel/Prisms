# Prisms — Security Remediation Playbook (SEC-1 … SEC-7)

**Baseline:** `9ca4dc6` (origin/main). **Branch:** `feat/security-remediation`.
**Date:** 2026-07-28. **Scope:** the whole platform (API, dispatcher, core, sync
rules, clients, infra), not a single diff.

## How this review was produced (and its limits)

An 8-dimension adversarial review fanned out over the real code
(authn/session · authz+tenant-isolation · jwt/crypto · injection/input ·
web/client/CSP · infra/deploy · jobs/SSRF/DoS · supply-chain). The finder phase
completed and produced **27 findings**; the adversarial verification phase was
**cut short by a usage limit** (21 of 63 agents finished), so the machine-assigned
severities are not independently confirmed.

**Every finding this playbook acts on was therefore re-verified by hand**, by
reading the cited code and, where it mattered, the dependency source. Findings
that could not be substantiated are listed under *Rejected / deferred* with the
reason. Three items in the finder set were **not** independently reproducible and
are explicitly NOT scheduled.

One finding below (**SEC-4b, RRULE expansion**) was found by direct inspection,
not by the fan-out — the finders missed it.

## Threat model (what we are defending)

Self-hosted, single small node (Surface Go class), Postgres + PowerSync + API
behind Tailscale/nginx. **Multi-user** email+password. The invariants:

1. **Tenant isolation** — no user may ever read or write another user's rows.
2. **Availability** — one user must not be able to wedge the shared node.
3. **Secret containment** — signing secrets never leave the host.

Isolation (1) held up well under review: every dispatcher handler ownership-checks
its referenced rows, every sync-stream query filters `auth.user_id()`, trust
fields are stripped pre-parse, and import forces `user_id`. **No cross-tenant
read/write path was found.** The real exposure is concentrated in (2) and (3).

## Confirmed findings → sessions

| ID | Severity | Finding | Verified how | Session |
|----|----------|---------|--------------|---------|
| F1 | **High** | Client-spoofable `X-Forwarded-For` defeats the auth brute-force limiter | Read `better-auth@1.6.16/dist/utils/get-request-ip.mjs`: defaults to `["x-forwarded-for"]`, takes `.split(",")[0]`. nginx uses `$proxy_add_x_forwarded_for`, which **appends** — so element 0 is attacker-controlled. Unlimited online password guessing. | SEC-2 |
| F2 | **High** | ReDoS via blocker-rule `matches` predicate | `predicate.ts:296` compiles `new RegExp(expected,'i')` and tests it against unbounded strings. The S3-F7 cap bounds *pattern length* (200) — irrelevant to backtracking (`(a+)+$` is 6 chars). Reachable server-side from `timer.clock_in` → `isBlockedForAcceptance`. Pegs the shared event loop for **all** users. | SEC-4 |
| F3 | **Medium** | Production `.env` baked into the web image build layer | `apps/web/Dockerfile:8` is `COPY . .`; `.dockerignore` has no `.env` entry; `.env` exists at repo root (791 B, gitignored). `POSTGRES_PASSWORD`/`BETTER_AUTH_SECRET`/`PS_JWT_SECRET` land in an image layer. | SEC-1 |
| F4 | **Medium** | Non-finite numeric env silently disables rate limiting | `env.ts:92` `Number(env.COMMAND_RATE_LIMIT)`; `NaN` propagates to `rate-limit.ts:38` where `recent.length + count > NaN` is **always false** ⇒ limiter permanently open, no error. | SEC-1 |
| F5 | **Medium** | Unbounded `depends_on` ⇒ per-element DB-query amplification | `envelope.ts:30` `z.array(uuidSchema)` with no `.max()`. `commands` is capped at 100, but each element's `depends_on` drives a sequential query in `causalReject` (`dispatcher.ts:1580`). A 2 MB body ≈ 55k uuids ⇒ 55k queries/request. Same shape for `layout.renormalize_order.node_ids` (`payloads.ts:307`, one query per id at `dispatcher.ts:1439`). | SEC-3 |
| F6 | **Medium** | Unbounded string / JSON inputs | Only `journal.content` has `.max()`. `title`/`description`/`label`/`rrule` are unbounded, and `jsonValueSchema` (`primitives.ts:56`) is an unbounded recursive `z.lazy` used for `attributes`, rule `conditions`/`actions`, blocker `predicate` — parse-cost + storage amplification, and it is the ReDoS *subject* amplifier for F2. | SEC-3 |
| F7 | **Medium** | RRULE expansion has no frequency/count bound *(found by inspection, not the fan-out)* | `occurrences.ts:61` `rule.between(from,to,true)`; `rrule` is an unvalidated `z.string().min(1)`. A `FREQ=SECONDLY` habit materialises tens of millions of Dates. `runAggregatesRecomputeAll` (`aggregates-recompute.ts:170`) loops **all users sequentially**, so one user's rule stalls the nightly job for everyone. | SEC-4 |
| F8 | **Medium** | CSP `connect-src` permits exfiltration to any host | nginx `web.conf:15,53` allows bare `ws:`/`wss:`; Tauri `tauri.conf.json:25` allows `https:` **and** `wss:`. Any injected script can stream data out. | SEC-5 |
| F9 | **Medium** | Cron batch jobs have no per-user error isolation | `weather-poll.ts:87`, `aggregates-recompute.ts:170`, `pastdue-scan.ts:155` iterate all users with no `try/catch` — one user's bad row or one upstream blip aborts the cycle for everyone. | SEC-6 |
| F10 | **Medium** | Open self-service registration, no email verification | `auth.ts:27` sets only `emailAndPassword:{enabled:true}`. Combined with F1, unlimited account creation on an exposed origin. | SEC-2 |
| F11 | **Low** | Rate-limiter map never evicts | `rate-limit.ts:30` — emptied key arrays are retained forever; unbounded growth keyed by `${userId}:${verb}`. | SEC-6 |
| F12 | **Low** | Web Push posts to a fully user-controlled `endpoint` (latent SSRF) | `push.ts:49`. **Not currently reachable** — no route writes `push_subscriptions`. Fix before the wearables/push work makes it reachable. | SEC-6 |
| F13 | **Low** | `node.create`/`activity.promote` accept an unvalidated `habit_id` | `dispatcher.ts:587,702` write `habit_id` with no ownership/existence check (no FK on the column). I3 justification treats it as a boolean, so the invariant is trivially satisfiable with a foreign/random uuid. **Tenant-internal only** — no cross-user read/write. Inconsistent with `tag.create` (`:1105`), which does check. | SEC-7 |
| F14 | **Low** | Containers run as root; no `USER` directive | `apps/server/Dockerfile:33`, `apps/web/Dockerfile:16`. | SEC-1 |
| F15 | **Low** | HSTS never emitted; `sslmode=disable` PowerSync↔Postgres | `web.conf:16` (commented out), `powersync.prod.yaml:10`. | SEC-5 |
| F16 | **Low** | `PRISMS_ALLOW_DEV_SECRETS` permits the repo-public HS256 secret in production | `env.ts:50`. Escape hatch is legitimate but silent-ish; forged PowerSync tokens for any `sub` if ever set. | SEC-1 |
| F17 | **Low** | Export/import manifest arrays unbounded | `manifest.ts:28` — a 32 MB import becomes one huge transaction + oversized `IN` lists. | SEC-3 |
| F18 | **Low** | Vulnerable transitive `esbuild@0.18.20` via `drizzle-kit` → `@esbuild-kit/esm-loader` | `pnpm-lock.yaml`. Dev-only toolchain (GHSA-67mh-4wv8-2f99, dev-server request forwarding). | SEC-7 |

### Rejected / deferred (finder claims that did **not** survive hand-verification)

- **Weather-poll SSRF** — `weather_location.lat/lon` are `z.number()` range-bounded
  (`entities.ts:427`), so the Open-Meteo URL is not injectable. *Not a finding.*
- **Journal/note XSS** — rendering is `react-markdown` + `remark-gfm` with **no**
  `rehype-raw`; raw HTML is never rendered. *Not a finding.*
- **Cross-tenant IDOR in the dispatcher** — every handler ownership-checks its
  referenced rows; the one gap (F13) is tenant-internal. *Not a finding.*
- **PowerSync token lacks `iss` / rotation path** (info) — real but a design
  limitation with a standing TODO (RS256/JWKS); not scheduled here.
- **Prod runs `tsx`** (info) — a performance/footprint choice, not a vulnerability.
- **Floating image tags / caret ranges** (info) — supply-chain hygiene; documented,
  not mechanically changed in this pass.
- **Account enumeration via sign-up** — plausible but better-auth's response shape
  was not verified end-to-end; folded into SEC-2 as a best-effort hardening, not
  claimed as fixed.

## Sessions

Each session is a commit on `feat/security-remediation`. **Gate for every
session:** `pnpm turbo lint typecheck test` plus `@prisms/core test:coverage`
(≥90 floor). Integration tests need Postgres up (`wsl docker compose up -d`,
`PRISMS_DB_TEST_URL=postgresql://…@127.0.0.1:5434/…`).

### SEC-1 — Secret containment & boot safety *(F3, F4, F14, F16)*
**Owns:** `.dockerignore`, `apps/*/Dockerfile`, `apps/server/src/env.ts`.
**Forbidden:** dispatcher, core schemas.
1. `.dockerignore`: exclude `.env` and `.env.*`, keep `.env.example`. *(F3)*
2. `env.ts`: parse numeric env through a validating helper — non-finite/negative
   is a **boot error**, never a silently-open limiter. *(F4)*
3. Dockerfiles: run as a non-root `USER`. *(F14)*
4. `env.ts`: make the dev-secret override log an unmissable warning and refuse
   to combine with a public `BETTER_AUTH_URL`. *(F16)*

### SEC-2 — Authentication hardening *(F1, F10)*
**Owns:** `apps/server/src/auth.ts`, `app.ts` (auth route only), `infra/nginx/web.conf` (XFF only).
1. nginx: `proxy_set_header X-Forwarded-For $remote_addr` — **overwrite**, never
   append, so the client cannot forge element 0. Keep `X-Real-IP`. *(F1)*
2. better-auth: pin `advanced.ipAddress.ipAddressHeaders = ['x-real-ip']`. *(F1)*
3. Add an application-level limiter in front of `/api/auth/*`, keyed on the
   trusted proxy IP, independent of better-auth's. *(F1)*
4. Raise `minPasswordLength`; add `PRISMS_DISABLE_SIGNUP` to gate registration
   for single-family deployments. *(F10)*

### SEC-3 — Input bounds *(F5, F6, F17)*
**Owns:** `packages/core/src/commands/*`, `packages/core/src/domain/primitives.ts`, `packages/core/src/sync/manifest.ts`.
1. `depends_on` and `node_ids` get `.max()`. *(F5)*
2. Bound every free-text command field; add a depth+breadth-bounded JSON schema
   for `attributes`/`conditions`/`actions`/`predicate`. *(F6)*
3. Bound manifest arrays. *(F17)*

### SEC-4 — Algorithmic DoS *(F2, F7)*
**Owns:** `packages/core/src/status/predicate.ts`, `packages/core/src/aggregates/occurrences.ts`.
1. Replace unrestricted `RegExp` with a **linear-time-safe** matcher: reject
   patterns containing nested/ambiguous quantifiers at authoring time
   (`validateAutomationRule` path) *and* fail safe at eval time, plus bound the
   subject length. *(F2)*
2. RRULE: allowlist sane `FREQ` values, cap expansion count and window. *(F7)*

### SEC-5 — Transport & content security *(F8, F15)*
**Owns:** `infra/nginx/web.conf`, `apps/desktop/src-tauri/tauri.conf.json`, `infra/powersync/powersync.prod.yaml`, `SELF_HOSTING` docs.
1. Tighten `connect-src` to same-origin + the configured PowerSync origin;
   drop bare `ws:`/`wss:`/`https:`. *(F8)*
2. Emit HSTS (documented for TLS-terminated deployments); document the
   `sslmode` posture for the container network. *(F15)*

### SEC-6 — Job & runtime resilience *(F9, F11, F12)*
**Owns:** `apps/server/src/jobs/*`, `apps/server/src/rate-limit.ts`.
1. Per-user `try/catch` in every all-users cron loop; log and continue. *(F9)*
2. Evict empty keys from the limiter; bound total key count. *(F11)*
3. Allowlist Web Push endpoint scheme/host; block private/loopback ranges. *(F12)*

### SEC-7 — Authorization consistency & close-out *(F13, F18)*
**Owns:** `apps/server/src/dispatcher.ts`, `apps/server/src/jobs/import-restore.ts`, docs.
1. Ownership-check `habit_id` in `node.create`/`activity.promote`. *(F13)*
2. Note the `esbuild` transitive advisory + upgrade path. *(F18)*
3. Full gate; update `docs/` + this playbook's tracker.

## Tracker

| Session | Status | Commit | Notes |
|---------|--------|--------|-------|
| SEC-1 | ✅ | `ab171dc` | .env out of the image; strict numeric env; dev-secret hatch loopback-only; API non-root |
| SEC-2 | ✅ | `fd32f00` | XFF overwrite + pinned IP header + fail-closed credential throttle; sign-up policy |
| SEC-3 | ✅ | `78f2d48` | depends_on/node_ids caps; text ceilings; bounded JSON; manifest bounds |
| SEC-4 | ✅ | `d29884f` | linear-time-safe regex subset; RRULE frequency allowlist + occurrence cap |
| SEC-5 | ✅ | `f676f82` | connect-src 'self'; Tauri prod/dev CSP split; HSTS via X-Forwarded-Proto |
| SEC-6 | ✅ | `ffa36cc` | per-user job isolation; limiter eviction; Web Push endpoint allowlist |
| SEC-7 | ✅ | *(this commit)* | habit_id ownership; esbuild advisory noted; close-out |

## Verification performed

- **Unit/integration:** server suite green vs live Postgres (189 + 7 new
  ownership cases); core 613 green; 5 new test files, 80+ new cases. Every High
  and Medium fix carries a REGRESSION test that replays the actual attack
  (rotating `X-Forwarded-For`, `(a+)+$`, `FREQ=SECONDLY`, mid-batch job failure).
- **Config:** `infra/nginx/web.conf` validated with `nginx -t` against
  `nginx:1.27-alpine` — syntax OK.
- **Gate:** `turbo typecheck lint` 14/14; core coverage 90.73% statements
  (floor 90).
- Known flake, unrelated: `packages/core/test/architecture-lint.test.ts` times out
  at 30 s under full concurrency (it shells out to ESLint); 15/15 in isolation.

## Residual risk — deliberately NOT changed

These are real but were not safe to change blind from this environment. Each is
documented where an operator will meet it:

1. **Tauri `connect-src https: wss:`** (`apps/desktop`) — still scheme-wide,
   because the operator's server origin is a build-time input this repo cannot
   know. Production/dev policies were split so packaged builds no longer reach
   arbitrary localhost ports, and the desktop README documents pinning the origin
   before distribution. *A packaged build with an unpinned CSP retains an
   exfiltration channel.*
2. **nginx runs as root (master)** — the stock image's behaviour (workers drop to
   `nginx`). Going rootless needs `nginxinc/nginx-unprivileged`, a listen-port
   move and a compose remap: a deployment-topology change with no way to
   end-to-end test it here.
3. **`sslmode: disable` PowerSync↔Postgres** — acceptable only while both stay on
   the private compose bridge. `powersync.prod.yaml` now states what must change
   (`verify-full` + mounted CA) if Postgres ever moves off-host.
4. **PowerSync JWT is HS256 with a shared symmetric secret** — API and sync
   service hold the same key, so there is no rotation path and compromise of
   either forges tokens for any `sub`. The standing TODO (RS256 + API-served
   JWKS) remains the right fix; it is a protocol change, not a hardening tweak.
5. **`esbuild@0.18.20`** reaches the tree transitively via
   `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`
   (GHSA-67mh-4wv8-2f99: the dev server accepts cross-origin requests). It is a
   **devDependency of `@prisms/db` only**, used by `db:generate`/`db:migrate` —
   never installed in the production API image and never serving. Real fix is
   upstream (drizzle-kit dropped `@esbuild-kit/*` in later releases); revisit on
   the next drizzle-kit bump.
6. **Account enumeration via sign-up** — better-auth's exact response for a
   duplicate email was not verified end to end, so no claim is made that it is
   fixed. `PRISMS_DISABLE_SIGNUP=1` removes the surface entirely for a
   provisioned deployment.
7. **Rate limiting is per-process, in-memory.** Correct for the single-node v1
   deployment; a second API replica would give each its own buckets. Moving to
   Postgres/Redis is a topology decision, not a patch.

### Operational note — the credential throttle's degraded mode

The SEC-2 throttle keys on `X-Real-IP`, which the bundled nginx sets and
overwrites. **Reached without that proxy — direct-to-API dev, CI, or a
hand-rolled deployment — every caller collapses into one shared bucket.** That is
the intended fail-closed behaviour (over-throttling beats unbounded guessing),
but it is surprising in the moment: you get 429s that look inexplicable.

This actually bit the e2e job on the first CI run of this branch: 5 of 29 specs
failed on a missing `sync-state`, because each spec signs in and the suite blew
through the shared 10/min budget. Two things came out of it:

- CI now sets `AUTH_RATE_LIMIT: '10000'` for the e2e job (the limit only — the
  keying and fail-closed behaviour are untouched and still covered by
  `apps/server/test/auth-throttle.test.ts`).
- The server now warns **once per process** when it has to fall back to the
  shared bucket, naming the cause and both remedies, so the next person meets a
  diagnosis instead of a mystery.

If you run the API directly, either front it with the bundled proxy or set
`AUTH_RATE_LIMIT` deliberately.

## Follow-ups worth scheduling

- Adopt RS256 + JWKS for PowerSync tokens (residual 4) — the largest remaining
  structural item.
- Re-run the adversarial verification phase that the usage limit cut short; the
  finder output for `infra-deploy`, `jwt-crypto` and `supply-chain` was never
  independently verified, and the completeness critic never ran.
- Add an e2e assertion that the shipped CSP header matches the intended policy,
  so a future nginx edit cannot silently loosen it.
