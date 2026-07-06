# Prisms promotional site

Static, zero-dependency marketing site for Prisms — plain HTML + CSS + a small
scene engine (`site.js`) that plays looping product "recordings" (fake cursor,
task check-off, timer, agenda commit, kanban drag, two-device sync, automation
firing) when a scene scrolls into view. No build step, no package.json —
invisible to pnpm/turbo/CI.

Pages:

- `index.html` — hero with an animated My Day app-window playback, product-tour
  teasers, "why Prisms" grid, closing CTA.
- `features.html` — the full tour: structure (tree + Gantt), kanban by date,
  agenda, habits + journal, automations. Anchors: `#plan` `#board` `#agenda`
  `#habits` `#automations`.
- `platforms.html` — two-device offline→sync convergence playback, web/desktop/
  mobile cards, sync guarantees.
- `self-host.html` — 3-step quickstart, compose snippet, stack chips, hardware
  callout, trust/portability lists, FAQ.

Notes:

- Design tokens are copied from `packages/ui/src/theme.css` so the mockups
  match the real app; keep them in sync if the app re-themes.
- `prefers-reduced-motion` renders every scene as its static final state.
- Preview locally: the `landing` entry in `.claude/launch.json`
  (`npx http-server apps/landing -p 4174`).
- Deploy: copy the folder to any static host (nginx/Caddy/Pages). Self-contained
  except the Google Fonts Inter stylesheet, which degrades to system fonts.
