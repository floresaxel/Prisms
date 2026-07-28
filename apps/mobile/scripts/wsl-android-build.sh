#!/usr/bin/env bash
# Builds the Android APK inside WSL — the Windows-native build cannot complete
# from this repo location (see ../README.md, "Building on Windows").
#
# Runs against the WSL clone at ~/dev/prisms, whose `origin` is the Windows
# checkout, so it builds the LAST COMMITTED state of the given branch — never
# uncommitted edits.
#
# Usage: wsl-android-build.sh <branch> <debug|release> [--cleartext] [out.apk]
#
#   --cleartext  release only: allow plain-http endpoints so a release APK can
#                talk to the local dev stack. Android blocks cleartext in
#                release builds by default and that default is CORRECT for
#                production (prod is HTTPS) — this patches the WSL working
#                tree only and is never committed.
set -euo pipefail

BRANCH="${1:?usage: wsl-android-build.sh <branch> <debug|release> [--cleartext] [out.apk]}"
VARIANT="${2:?usage: wsl-android-build.sh <branch> <debug|release> [--cleartext] [out.apk]}"
CLEARTEXT=""
OUT=""
for arg in "${@:3}"; do
  case "$arg" in
    --cleartext) CLEARTEXT=1 ;;
    *) OUT="$arg" ;;
  esac
done

# Self-contained: this script is launched with plain `bash -c`, which loads no
# profile, so nothing can be inherited from the login environment.
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
# Inlined into the JS bundle at export time (debug reads them again from Metro,
# but release has no Metro — the values baked here are all it will ever have).
# 10.0.2.2 is the emulator's alias for the host loopback.
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://10.0.2.2:3001}"
export EXPO_PUBLIC_POWERSYNC_URL="${EXPO_PUBLIC_POWERSYNC_URL:-http://10.0.2.2:8081}"
# The first build downloads the NDK; dl.google.com times out under that load.
export GRADLE_OPTS="-Dorg.gradle.internal.http.socketTimeout=180000 -Dorg.gradle.internal.http.connectionTimeout=180000"

cd ~/dev/prisms
git fetch -q origin
git reset --hard -q
git clean -fdq -e node_modules -e android -e ios
git checkout -q -B "$BRANCH" "origin/$BRANCH"
echo "building $(git log --oneline -1)"
pnpm install --frozen-lockfile

cd apps/mobile
if [ "$VARIANT" = "release" ] && [ -n "$CLEARTEXT" ]; then
  python3 - <<'EOF'
import json
with open('app.json') as f:
    cfg = json.load(f)
plugins = [p for p in cfg['expo'].get('plugins', [])
           if not (isinstance(p, list) and p and p[0] == 'expo-build-properties')]
plugins.append(['expo-build-properties', {'android': {'usesCleartextTraffic': True}}])
cfg['expo']['plugins'] = plugins
with open('app.json', 'w') as f:
    json.dump(cfg, f, indent=2)
print('app.json: cleartext allowed (uncommitted, this build only)')
EOF
fi

npx expo prebuild --platform android
cd android
if [ "$VARIANT" = "debug" ]; then
  ./gradlew app:assembleDebug -PreactNativeArchitectures=x86_64 -PreactNativeDevServerPort=8090
  APK=app/build/outputs/apk/debug/app-debug.apk
else
  ./gradlew app:assembleRelease -PreactNativeArchitectures=x86_64
  APK=app/build/outputs/apk/release/app-release.apk
fi

if [ -n "$OUT" ]; then
  cp "$APK" "$OUT"
  echo "APK copied to $OUT"
fi
echo "WSL_ANDROID_BUILD_OK $VARIANT"
