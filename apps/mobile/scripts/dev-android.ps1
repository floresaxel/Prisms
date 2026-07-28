<#
.SYNOPSIS
One command from a clean machine to the app running on the Android emulator.

The native build runs in WSL (Windows cannot build this repo — see the README's
"Building on Windows" section); everything else — the dev stack, the API
server, the emulator, Metro — runs on Windows. This script sequences all of it
and encodes every trap that cost time to find:

  * WSL idles out and takes the containers and any detached build with it,
    so it is pinned for 8 h first.
  * The API the emulator talks to is a HOST server on :3001 (the compose api
    maps to :3002); if nothing is listening it is started with the dev-stack
    JWT overrides the gitignored .env would otherwise poison.
  * The build runs BEFORE the emulator boots — booting while gradle saturates
    the CPU wedges the emulator's SystemUI.
  * `expo start` without `--offline` dies silently on this machine, and a
    stale Metro on :8090 makes the next one silently pick :8091.
  * Metro must run on WINDOWS: the emulator's 10.0.2.2 reaches the Windows
    host, not WSL. Port 8090, because PowerSync owns 8081 here.

.EXAMPLE
pwsh apps/mobile/scripts/dev-android.ps1                    # debug build + run
pwsh apps/mobile/scripts/dev-android.ps1 -SkipBuild         # reuse the last APK
pwsh apps/mobile/scripts/dev-android.ps1 -Variant release -Cleartext
#>
param(
  [ValidateSet('debug', 'release')] [string]$Variant = 'debug',
  [switch]$SkipBuild,
  # Release only: let the release APK talk to the plain-http dev stack.
  # Never committed — release builds correctly block cleartext for prod.
  [switch]$Cleartext,
  [switch]$ClearMetroCache,
  [string]$Avd = 'Pixel_10_Pro_XL'
)
$ErrorActionPreference = 'Stop'

$repo = (git rev-parse --show-toplevel).Trim()
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$adb = "$sdk\platform-tools\adb.exe"
$emu = "$sdk\emulator\emulator.exe"
$apk = "$env:TEMP\prisms-$Variant.apk"
$wslRepo = '/mnt/' + $repo.Substring(0, 1).ToLower() + ($repo.Substring(2) -replace '\\', '/')

if ((git status --porcelain | Measure-Object).Count -gt 0) {
  Write-Warning 'Working tree is dirty — the WSL build uses the last COMMIT on this branch, not these edits.'
}

Write-Host "== [1/6] WSL + dev stack" -ForegroundColor Cyan
# A long sleep keeps the WSL VM (and with it Docker and any build) alive.
Start-Process wsl -ArgumentList '-d', 'Ubuntu', '--', 'sleep', '28800' -WindowStyle Hidden
wsl -d Ubuntu -- bash -c "cd '$wslRepo' && docker compose up -d --wait" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }

Write-Host "== [2/6] API server on :3001" -ForegroundColor Cyan
$apiUp = $false
try { $apiUp = (Invoke-WebRequest -Uri http://localhost:3001/health -TimeoutSec 5).StatusCode -eq 200 } catch {}
if (-not $apiUp) {
  # Shell env beats the .env file, whose prod-derived PowerSync secrets do not
  # match the dev compose powersync (see the dev-stack notes).
  Start-Process pwsh -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', @"
`$env:POWERSYNC_JWT_SECRET = 'prisms-dev-secret-change-me-32by'
`$env:POWERSYNC_JWT_KID = 'powersync-dev'
`$env:POWERSYNC_JWT_AUDIENCE = 'powersync-dev'
`$env:PS_JWT_K_B64URL = 'cHJpc21zLWRldi1zZWNyZXQtY2hhbmdlLW1lLTMyYnk'
`$env:PORT = '3001'
`$env:BETTER_AUTH_URL = 'http://localhost:5173'
`$env:BETTER_AUTH_TRUSTED_ORIGINS = 'http://localhost:5173'
`$env:PRISMS_JOBS_ENABLED = 'true'
Set-Location '$repo'
pnpm --filter @prisms/server start *> '$env:TEMP\prisms-api.log'
"@
  $deadline = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep -Seconds 3
    try { $apiUp = (Invoke-WebRequest -Uri http://localhost:3001/health -TimeoutSec 3).StatusCode -eq 200 } catch {}
  } until ($apiUp -or (Get-Date) -gt $deadline)
  if (-not $apiUp) { throw "API never came up — see $env:TEMP\prisms-api.log" }
}

if (-not $SkipBuild) {
  Write-Host "== [3/6] Building $Variant in WSL (debug ~5-11 min warm, release much longer cold)" -ForegroundColor Cyan
  $flags = if ($Variant -eq 'release' -and $Cleartext) { '--cleartext' } else { '' }
  $script = "$repo\apps\mobile\scripts\wsl-android-build.sh" -replace '\\', '/'
  $wslScript = '/mnt/' + $script.Substring(0, 1).ToLower() + $script.Substring(2)
  $wslOut = '/mnt/' + $apk.Substring(0, 1).ToLower() + ($apk.Substring(2) -replace '\\', '/')
  # tr strips the CRLFs a Windows checkout may have added.
  wsl -d Ubuntu -- bash -c "tr -d '\r' < '$wslScript' > ~/wsl-android-build.sh && bash ~/wsl-android-build.sh '$branch' '$Variant' $flags '$wslOut'"
  if ($LASTEXITCODE -ne 0) { throw 'WSL build failed' }
} else {
  Write-Host "== [3/6] Skipping build — reusing $apk" -ForegroundColor Yellow
  if (-not (Test-Path $apk)) { throw "No previous $Variant APK at $apk — run without -SkipBuild first" }
}

Write-Host "== [4/6] Emulator" -ForegroundColor Cyan
$booted = ''
try { $booted = (& $adb shell getprop sys.boot_completed 2>$null) -join '' } catch {}
if ($booted -notmatch '1') {
  Start-Process $emu -ArgumentList '-avd', $Avd, '-no-snapshot-load', '-no-boot-anim'
  $deadline = (Get-Date).AddMinutes(4)
  do {
    Start-Sleep -Seconds 8
    try { $booted = (& $adb shell getprop sys.boot_completed 2>$null) -join '' } catch { $booted = '' }
  } until ($booted -match '1' -or (Get-Date) -gt $deadline)
  if ($booted -notmatch '1') { throw 'Emulator did not finish booting — is another instance wedged? (adb emu kill)' }
  # A fresh boot can still throw system ANR dialogs for a minute; taps land oddly until it settles.
  Start-Sleep -Seconds 10
}

Write-Host "== [5/6] Installing $apk" -ForegroundColor Cyan
& $adb install -r $apk | Select-Object -Last 1

if ($Variant -eq 'debug') {
  Write-Host "== [6/6] Metro on :8090" -ForegroundColor Cyan
  Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  $clear = if ($ClearMetroCache) { '--clear' } else { '' }
  Start-Process pwsh -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', @"
`$env:EXPO_PUBLIC_API_URL = 'http://10.0.2.2:3001'
`$env:EXPO_PUBLIC_POWERSYNC_URL = 'http://10.0.2.2:8081'
Set-Location '$repo\apps\mobile'
pnpm exec expo start --port 8090 --offline $clear *> '$env:TEMP\prisms-metro.log'
"@
  $deadline = (Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Seconds 3
    $metro = Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue
  } until ($metro -or (Get-Date) -gt $deadline)
  if (-not $metro) { throw "Metro never listened — see $env:TEMP\prisms-metro.log" }
} else {
  Write-Host "== [6/6] Release build — no Metro needed" -ForegroundColor Cyan
}

& $adb shell monkey -p com.prisms.app -c android.intent.category.LAUNCHER 1 *> $null
Write-Host ''
Write-Host "DONE — $Variant build of '$branch' launching on $Avd." -ForegroundColor Green
if ($Variant -eq 'debug') {
  Write-Host "  Metro log:  $env:TEMP\prisms-metro.log  (first bundle takes 1-3 min; the app shows 'Bundling' meanwhile)"
}
Write-Host "  API log:    $env:TEMP\prisms-api.log  (only if this script started it)"
Write-Host "  Reinstall without rebuilding:  dev-android.ps1 -SkipBuild"
