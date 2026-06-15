/**
 * @prisms/desktop — Tauri v2 shell around the web build (§12.3).
 *
 * There is intentionally almost no TypeScript here: the desktop app loads the
 * identical `apps/web` build into a Tauri WebView (see src-tauri/tauri.conf.json
 * → frontendDist). PowerSync persists in that WebView via the web SDK
 * (wa-sqlite/OPFS); OS notifications are wired in the web layer (apps/web
 * src/desktop.ts) against the Tauri notification plugin. The Rust shell lives
 * in src-tauri/.
 */
export const DESKTOP_APP = '@prisms/desktop' as const;
