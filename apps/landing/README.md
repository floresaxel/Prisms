# Prisms landing page

Static, zero-dependency marketing page for Prisms. Plain HTML + CSS + a small
scene engine (`landing.js`) that plays looping product "recordings" (fake
cursor, task check-off, timer, agenda commit, automation firing) when a scene
scrolls into view. No build step, no package.json — invisible to pnpm/turbo/CI.

- Design tokens are copied from `packages/ui/src/theme.css` so the mockups
  match the real app; keep them in sync if the app re-themes.
- `prefers-reduced-motion` renders every scene as its static final state.
- Preview locally: `npx http-server apps/landing -p 4174` (or the `landing`
  entry in `.claude/launch.json`).
- Deploy: copy the three files to any static host (nginx/Caddy/Pages). The
  page is self-contained except for the Google Fonts Inter stylesheet, which
  degrades gracefully to system fonts offline.
