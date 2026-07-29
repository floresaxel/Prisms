# @prisms/desktop

Tauri v2 desktop shell (Windows + macOS). It loads the **identical `apps/web`
build** into a native WebView — no separate desktop UI. The Rust shell is in
`src-tauri/`.

## Architecture note — persistence (deviation from the build line)

The build plan says "SQLite via the Tauri SQL plugin behind the same PowerSync
interface." In practice PowerSync's local database is **not vanilla SQLite** —
it requires PowerSync's own SQLite build with the `powersync` extension loaded,
which the vanilla Tauri SQL plugin (sqlx, plain SQLite) cannot host. The
supported path is therefore the one used here: the WebView runs the existing
`@powersync/web` SDK (wa-sqlite / OPFS), which works in Tauri v2's WebView
(WebView2 / WKWebView both support OPFS). This keeps a single shared web bundle
and the *same PowerSync interface* literally — only the host (WebView vs.
browser tab) differs. OS notifications use the Tauri notification plugin via
`apps/web/src/desktop.ts` (`osNotify`, guarded by `isDesktop()`).

## Security — pin the CSP origin before you distribute a build (SEC-5/F8)

`src-tauri/tauri.conf.json` ships two policies:

- `csp` (production) — `connect-src 'self' https: wss:`
- `devCsp` — the same plus `http://localhost:*` / `ws://localhost:*` for `tauri dev`

Splitting them means a **packaged** build can no longer open connections to
arbitrary localhost ports on the user's machine; that grant now exists only in
dev.

`https:`/`wss:` are still SCHEME sources — they match *any* host, so a script
that got a foothold could stream your replica to an attacker. They are the
default only because this repo cannot know your server's origin: the desktop app
loads the same `apps/web` bundle, whose API and sync URLs are baked in at build
time from `VITE_API_URL` / `VITE_POWERSYNC_URL`.

**Before distributing a build, replace them with your own origin**, e.g.:

```json
"csp": "default-src 'self'; connect-src 'self' https://prisms.example.com wss://prisms.example.com; ..."
```

That makes exfiltration to a third-party host a CSP violation rather than an
allowed request.

## Run / build (needs the Rust toolchain)

```bash
pnpm --filter @prisms/desktop dev      # tauri dev — builds web + opens the window
pnpm --filter @prisms/desktop build    # tauri build — packaged installers
pnpm --filter @prisms/desktop tauri icon ./icon.png   # generate src-tauri/icons/*
```

Prereqs: Rust (≥1.77), and the platform WebView/build tools (WebView2 +
MSVC on Windows; Xcode CLT on macOS).

> Note: this repo's build environment (Windows + WSL for the Docker server
> stack only) does **not** have the Rust toolchain, so the Tauri build and the
> `tauri-driver` e2e (`e2e/worklist-offline.e2e.ts`) are committed but
> **unrun**. The desktop package is gate-verified by
> `pnpm turbo lint typecheck test` (the TS side) and reuses the web app, which
> is itself fully Playwright-verified. Icons must be generated (`tauri icon`)
> before a real `tauri build`.

## DoD (tauri-driver)

`e2e/worklist-offline.e2e.ts` (WebdriverIO + `tauri-driver`) mirrors S16's
offline worklist loop in the packaged window and checks an OS notification —
run on a machine with the Tauri toolchain + a packaged debug build.
