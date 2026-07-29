# @prisms/mobile

Expo (React Native) client — the §12.1 mobile surface: worklist + timer + focus
review, agenda with tap-to-place, kanban, habits + daily-target meters,
dashboard, and a read-only navigate-on-tap graph view. It reuses the shared
`@prisms/ui` reactive hooks + command bridge unchanged — only the SQLite driver
(react-native-quick-sqlite via `@powersync/react-native`) and the UI chrome
differ from web.

## Run on the Android emulator (this machine)

One command builds in WSL, boots the `Pixel_10_Pro_XL` AVD, installs, starts
Metro and launches the app:

```bash
pwsh apps/mobile/scripts/dev-android.ps1
```

`-SkipBuild` reuses the last APK (edit → Fast Refresh needs no rebuild at all —
only native/dependency changes do). `-Variant release -Cleartext` builds the
embedded-bundle release APK that can still talk to the plain-http dev stack.
The script sequences the whole machine: WSL pin, docker compose, the host API
on :3001, the WSL gradle build, emulator boot (deliberately *after* the build —
booting while gradle saturates the CPU wedges the emulator), `adb install`, and
Metro on :8090 with `--offline` (without it Expo dies silently here).

Android Studio itself is only used as the SDK/AVD provider on this machine —
its Run button would build natively on Windows, which hits the MAX_PATH wall
below. Open it to manage AVDs, not to build.

## Run (generic Expo flow, other machines)

```bash
pnpm --filter @prisms/mobile start      # Expo dev server
pnpm --filter @prisms/mobile android    # or: ios
```

On a device or emulator `localhost` is the device itself, so the endpoints have
to be pointed at your machine. `src/config.ts` reads `EXPO_PUBLIC_API_URL` and
`EXPO_PUBLIC_POWERSYNC_URL`, which Expo inlines at bundle time — set them on the
**Metro process**, not on the app:

```bash
EXPO_PUBLIC_API_URL=http://10.0.2.2:3001 \
EXPO_PUBLIC_POWERSYNC_URL=http://10.0.2.2:8081 \
pnpm --filter @prisms/mobile android
```

`10.0.2.2` is the Android emulator's alias for the host loopback. Use the host's
LAN IP for a physical device. Don't reach for `adb reverse` here — the dev
stack puts PowerSync on host port 8081, which collides with Metro's own default
port.

## Building on Windows (the MAX_PATH problem) — UNRESOLVED

The Android native build **does not currently complete on Windows from this
repo's default location**, and the cause is path length, not configuration.

CMake bakes each source file's full path into its object filename, so any C++
target that pulls sources from outside its own directory (React Native's Fabric
codegen does this everywhere) pays the project path twice. Two symptoms, same
root cause:

- `ninja: error: ... Filename longer than 260 characters`
- `ninja: error: manifest 'build.ninja' still dirty after 100 tries` — CMake
  cannot place the object files, so it regenerates the manifest forever

`LongPathsEnabled` is already `1` on the affected machine and does **not** help:
the ninja bundled with CMake 3.22.1 is not long-path aware.

Measured worst case (`expo-modules-core`'s fabric target), budget 250:

| repo root | pnpm default (`.pnpm`) | `node-linker=hoisted` |
|---|---|---|
| `C:\Users\<u>\OneDrive\Documents\Claude\Projects\Prisms_alpha` | 393 | 307 |
| `C:\dev\prisms` | 295 | **209** |
| `C:\p` | 277 | **191** |

So **both** changes are required — a short repo root *and* a hoisted node
layout. Either alone is still over budget, because pnpm's
`node_modules\.pnpm\<pkg>@<ver>\node_modules\<pkg>\` segment is ~75 characters
and appears twice in every object path.

Partial mitigations that helped but were not sufficient on their own:

- `subst P: "<repo>"` — a 2-character root. pnpm's workspace symlinks are
  relative so they follow it, but **library** packages resolve through the
  `.pnpm` store to their real `C:\` path, so they do not benefit.
- `buildStagingDirectory = file("C:/cx")` in `android/app/build.gradle` — fixed
  the `:app` module (398 → 249) and is genuinely needed, but `android/` is
  generated and gitignored, so `expo prebuild` erases it.
- `-PreactNativeArchitectures=x86_64` — halves the native compile for an
  emulator. Worth doing regardless.

If the build root ever changes, delete every stale `.cxx` first — CMake caches
absolute paths:

```bash
find . -type d -name .cxx -prune -exec rm -rf {} +
```

The option that sidesteps all of this — **now the working, scripted path** — is
building in WSL, where the limit does not exist: SDK + NDK live at
`/opt/android-sdk`, the repo is cloned to `~/dev/prisms` (ext4; its `origin` is
this Windows checkout, so committed work builds without pushing anywhere), and
the APK comes back over `/mnt/c` for `adb install` from Windows.
`scripts/wsl-android-build.sh` is that recipe made repeatable —
`scripts/dev-android.ps1` drives it end to end. Two traps it encodes: a WSL
idle-out kills detached builds *and* the docker stack (the script pins WSL
first), and release builds block cleartext HTTP by design (the `--cleartext`
flag patches the WSL tree only, never the repo).

## DoD flow (Maestro)

`.maestro/worklist-offline.flow.yaml` mirrors S16's offline loop (clock in → out
→ review with the network off) plus the local-notification check. Run with
`maestro test apps/mobile/.maestro/worklist-offline.flow.yaml` against an
emulator with a seeded `mobile-e2e@prisms.test` account.

> Note: the app now runs on the `Pixel_10_Pro_XL` emulator via the WSL-built
> APK (`scripts/dev-android.ps1`), so the Maestro flow is runnable in
> principle; it still needs its seeded `mobile-e2e@prisms.test` account and has
> not been wired into CI. The cheap no-device gate remains
> `pnpm turbo lint typecheck test` plus a Metro bundle
> (`expo export --platform android`), which catches babel/resolution breakage
> that typecheck cannot.

## Known follow-ups

- The device id persists across launches via `expo-secure-store` (`src/device.ts`,
  loaded at startup) so the §7.4 merge recognizes the same device after a
  restart. The session is still fetched once per launch — persist it too for a
  true offline cold-start.
- Rules/blockers/decision editors are web-only for now (mobile is the
  consumption + capture surface); add if needed.
- Rings use a bar meter; swap to `react-native-svg` arcs for true rings.
