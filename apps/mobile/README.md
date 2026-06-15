# @prisms/mobile

Expo (React Native) client — the §12.1 mobile surface: worklist + timer + focus
review, agenda with tap-to-place, kanban, habits + daily-target meters,
dashboard, and a read-only navigate-on-tap graph view. It reuses the shared
`@prisms/ui` reactive hooks + command bridge unchanged — only the SQLite driver
(react-native-quick-sqlite via `@powersync/react-native`) and the UI chrome
differ from web.

## Run

```bash
pnpm --filter @prisms/mobile start      # Expo dev server
pnpm --filter @prisms/mobile android    # or: ios
```

Point `src/config.ts` at a stack reachable from the device/emulator — on a
device `localhost` is the phone, so use your host's LAN IP (or an Expo tunnel)
for `apiBaseUrl` / `powersyncUrl`.

## DoD flow (Maestro)

`.maestro/worklist-offline.flow.yaml` mirrors S16's offline loop (clock in → out
→ review with the network off) plus the local-notification check. Run with
`maestro test apps/mobile/.maestro/worklist-offline.flow.yaml` against an
emulator with a seeded `mobile-e2e@prisms.test` account.

> Note: the build environment for this repo (Windows + WSL for the Docker server
> stack only) has no Android/iOS emulator, so the Maestro flow is committed but
> **unrun**. The app is verified by `pnpm turbo lint typecheck test`
> (`@prisms/mobile` typechecks + lints against the real Expo/RN/PowerSync types).

## Known follow-ups

- Persist the session + device id across launches (expo-secure-store) for true
  offline cold-start (today the session is fetched once per launch).
- Rules/blockers/decision editors are web-only for now (mobile is the
  consumption + capture surface); add if needed.
- Rings use a bar meter; swap to `react-native-svg` arcs for true rings.
