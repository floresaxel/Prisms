#Requires -Version 7.0
<#
.SYNOPSIS
One click from a cold machine to Prisms running at http://localhost:5173, with
no network needed.

.DESCRIPTION
Opens a small status window and brings the local dev stack up in order,
turning each part green as it answers:

  Project files > Docker (WSL) > Database > Migrations > PowerSync > API > Web app

Once all of it is up the window says so and shows a clickable link to the
site. It keeps watching after that, so a part that dies turns red instead of
the window going on claiming the stack is up.

Closing the window asks whether to stop the stack or leave it running. Only
what a launch of THIS script started is ever stopped: an API or web server
that some terminal already had running shows as "already running" and is left
alone.

Everything is local, so Docker images, node_modules and the pnpm store must
already be on the machine. Run `pnpm install` once while online.

The traps it handles (the Android script, apps/mobile/scripts/dev-android.ps1,
found most of them first):
  * WSL idles out and takes Docker with it, so the distro is pinned for as long
    as the stack runs.
  * Windows can reach a container's port a beat after `docker ps` calls it
    healthy, so readiness is judged from the Windows side.
  * The API is a HOST process on :3001 (compose's `api` is a stub on :3002). It
    gets the dev stack's PowerSync key in its environment, because the
    gitignored .env carries prod-derived values this PowerSync rejects.
  * PowerSync reads the schema once, when it boots, so a running one is
    restarted after a migration that actually applied something.
  * The web server must be on :5173 exactly (the origin auth trusts), so it
    fails loudly instead of drifting to :5174.
  * The repo lives in OneDrive, which can leave files online-only and then stop
    handing them over. Those are fetched up front, and a OneDrive that is not
    serving them is named plainly instead of surfacing later as a read error.
  * No global pnpm: each package.json script is run the way `pnpm run` would,
    from the repo's own node_modules\.bin. A packaged app such as Claude
    Desktop gets a private copy of AppData, so a pnpm installed from inside it
    does not exist for anything launched from the desktop.

Logs and launcher state live in ~\.prisms\dev-stack: outside OneDrive, and
outside AppData for the same packaged-app reason.

.EXAMPLE
pwsh scripts/prisms-stack.ps1 -InstallShortcut   # put a "Prisms" shortcut on the desktop
pwsh scripts/prisms-stack.ps1                    # the status window (what the shortcut opens)
pwsh scripts/prisms-stack.ps1 -NoGui             # the same, reported in this console
pwsh scripts/prisms-stack.ps1 -Stop              # stop whatever an earlier launch started
#>
[CmdletBinding()]
param(
  # report in this console instead of opening the status window
  [switch]$NoGui,
  # stop whatever an earlier launch started, then exit
  [switch]$Stop,
  # (re)create the "Prisms" desktop shortcut, then exit
  [switch]$InstallShortcut,
  [string]$Distro = 'Ubuntu'
)

$script:ScriptPath = $PSCommandPath
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:WindowTitle = 'Prisms · dev stack'

# ── the engine ────────────────────────────────────────────────────────────────
# Everything that touches the stack. It runs on a worker thread so the window
# stays responsive, which is why it is one scriptblock: the worker gets its
# text, and this script dot-sources it as well (for -Stop and the close prompt).
# All of it talks through the synchronized `$sync` table and nothing else.
$Engine = {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  function Write-StackLog([string]$Text) {
    try {
      [IO.File]::AppendAllText((Join-Path $sync.LogDir 'launcher.log'),
        ('{0:yyyy-MM-dd HH:mm:ss}  {1}{2}' -f (Get-Date), $Text, [Environment]::NewLine))
    } catch { }
  }

  # Rows are REPLACED, never edited, so the window can never read half a change.
  function Set-Row([string]$Key, [string]$State, [string]$Detail = '') {
    $old = $sync.Rows[$Key]
    if ($old -and $old.State -eq $State -and $old.Detail -eq $Detail) { return }
    $sync.Rows[$Key] = @{ State = $State; Detail = $Detail }
    $sync.Version++
    Write-StackLog ('{0,-8} {1,-8} {2}' -f $Key, $State, $Detail)
  }

  function Set-Phase([string]$Phase, [string]$Message = '') {
    $sync.Phase = $Phase
    $sync.Message = $Message
    $sync.Version++
    Write-StackLog "phase    $Phase  $Message"
  }

  # A step that fails names its row, so the window can mark the one that broke.
  function Stop-Step([string]$Key, [string]$Message) {
    $ex = [Exception]::new($Message)
    $ex.Data['row'] = $Key
    throw $ex
  }

  # Stop pressed (or the window closed) mid-start: every wait checks this.
  function Assert-Running {
    if ($sync.Cancel) { throw [OperationCanceledException]::new('cancelled') }
  }

  # The condition must emit ONLY its verdict — any stray output reads as true.
  function Wait-Until([scriptblock]$Condition, [int]$TimeoutSec, [int]$EveryMs = 1000) {
    $until = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
      Assert-Running
      if (& $Condition) { return $true }
      if ((Get-Date) -gt $until) { return $false }
      Start-Sleep -Milliseconds $EveryMs
    }
  }

  # Through cmd.exe with no window and the output in $Log. `/s` strips the
  # outer quotes, so the command keeps its own quoting intact.
  function Start-Hidden([string]$Command, [string]$Log, [hashtable]$Environment = @{}, [string]$WorkingDirectory = $sync.Repo) {
    $psi = [Diagnostics.ProcessStartInfo]::new($env:ComSpec)
    $psi.Arguments = '/d /s /c "' + $Command + ' > "' + $Log + '" 2>&1"'
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    foreach ($k in $Environment.Keys) {
      if ($null -eq $Environment[$k]) { [void]$psi.Environment.Remove($k) }
      else { $psi.Environment[$k] = [string]$Environment[$k] }
    }
    [Diagnostics.Process]::Start($psi)
  }

  function Get-ProcessRecord([Diagnostics.Process]$Process) {
    @{ Pid = $Process.Id; Start = $Process.StartTime.ToUniversalTime().Ticks }
  }

  # Is this still the process we started? A pid on its own can be reused by
  # Windows, so its start time has to match as well.
  function Test-Alive($Record) {
    if (-not $Record -or -not $Record.Pid) { return $false }
    $p = Get-Process -Id ([int]$Record.Pid) -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    try { [math]::Abs($p.StartTime.ToUniversalTime().Ticks - [int64]$Record.Start) -lt (2 * [TimeSpan]::TicksPerSecond) } catch { $false }
  }

  # The whole tree: cmd > pnpm > tsx/vite > node all have to go.
  function Stop-Tree([int]$Id) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $Id /T /F *> $null
  }

  # A short command run to completion. Its output is returned and also lands in
  # the launcher log; -Quiet keeps routine polls out of the log unless they fail.
  function Invoke-Logged([string]$Command, [int]$TimeoutSec = 120, [hashtable]$Environment = @{}, [string]$WorkingDirectory = $sync.Repo, [switch]$Quiet) {
    $tmp = Join-Path $sync.LogDir ('.run-{0}.tmp' -f [guid]::NewGuid().ToString('N').Substring(0, 8))
    $proc = Start-Hidden $Command $tmp $Environment $WorkingDirectory
    $until = (Get-Date).AddSeconds($TimeoutSec)
    $timedOut = $false
    while (-not $proc.WaitForExit(250)) {
      if ($sync.Cancel -or (Get-Date) -gt $until) { Stop-Tree $proc.Id; $timedOut = $true; break }
    }
    $out = ''
    try { $out = ([IO.File]::ReadAllText($tmp) -replace "`0", '').Trim() } catch { }
    try { [IO.File]::Delete($tmp) } catch { }
    $code = $timedOut ? -1 : $proc.ExitCode
    if (-not $Quiet -or $code -ne 0) {
      $body = $out ? [Environment]::NewLine + ($out -replace '(?m)^', '           ') : ''
      Write-StackLog ("run      $Command  [exit $code]" + $body)
    }
    Assert-Running
    @{ Code = $code; Out = $out }
  }

  # A package.json script, run the way `pnpm run` would: from the package's
  # folder, with its node_modules\.bin (then the root's) first on PATH. No
  # global pnpm needed, which matters here: a packaged app (Claude Desktop is
  # one) keeps a private copy of AppData, so a pnpm installed from inside one
  # is invisible to everything launched from the desktop.
  function Get-PackageScript([string]$Key, [string]$Dir, [string]$Name, [string]$ExtraArgs = '') {
    $pkgDir = Join-Path $sync.Repo $Dir
    $script = $null
    try { $script = ([IO.File]::ReadAllText((Join-Path $pkgDir 'package.json')) | ConvertFrom-Json).scripts.$Name } catch { }
    if (-not $script) { Stop-Step $Key "$Dir\package.json has no `"$Name`" script." }
    @{
      Command = $ExtraArgs ? "$script $ExtraArgs" : $script
      Dir     = $pkgDir
      Path    = (Join-Path $pkgDir 'node_modules\.bin') + ';' + (Join-Path $sync.Repo 'node_modules\.bin') + ';' + $env:Path
    }
  }

  function Get-WslCommand([string]$Rest) {
    'wsl.exe -d ' + $sync.Distro + ' --cd "' + $sync.Repo + '" -e ' + $Rest
  }

  # Both loopbacks: Postgres and PowerSync answer on 127.0.0.1, while Vite may
  # bind only ::1 when it resolves `localhost`.
  function Test-Port([int]$Port) {
    foreach ($ip in [Net.IPAddress]::Loopback, [Net.IPAddress]::IPv6Loopback) {
      $client = [Net.Sockets.TcpClient]::new($ip.AddressFamily)
      try { if ($client.ConnectAsync($ip, $Port).Wait(500) -and $client.Connected) { return $true } }
      catch { }
      finally { $client.Dispose() }
    }
    $false
  }

  function Get-HttpStatus([string]$Url, [int]$TimeoutSec = 5) {
    try { [int](Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -NoProxy -SkipHttpErrorCheck -ErrorAction Stop).StatusCode }
    catch { 0 }
  }

  function Get-PortOwner([int]$Port) {
    try {
      $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
      $p = Get-Process -Id $c.OwningProcess -ErrorAction Stop
      '{0} (pid {1})' -f $p.ProcessName, $p.Id
    } catch { 'another program' }
  }

  function Get-LastLine([string]$Text) {
    $lines = @($Text -split "`r?`n" | ForEach-Object { ($_ -replace '\x1b\[[0-9;?]*[A-Za-z]', '').Trim() } | Where-Object { $_ })
    if (-not $lines.Count) { return '' }
    $line = $lines[-1]
    $line.Length -gt 160 ? $line.Substring(0, 157) + '…' : $line
  }

  # Why did a server die? Its log knows; this puts the usual answers into words.
  function Get-FailureReason([string]$Log) {
    $text = ''
    try { $text = [IO.File]::ReadAllText($Log) } catch { }
    if ($text -match 'cloud file provider|cloud operation|UNKNOWN: unknown error, read|EIO: i/o error') {
      return "OneDrive isn't handing over files it needs. Make sure OneDrive is running, then try again."
    }
    if ($text -match 'EADDRINUSE|is already in use') { return 'its port is already in use.' }
    $last = Get-LastLine $text
    $last ? "it stopped with: $last" : 'it stopped before answering.'
  }

  function Save-StackState {
    $o = $sync.Owned
    $json = [ordered]@{ pin = $o.pin; api = $o.api; web = $o.web; compose = [bool]$o.compose } | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText($sync.StatePath, $json)
  }

  # What earlier launches left running — the state file is shared by every
  # launch (and by -Stop), so it is the truth rather than this process's memory.
  function Read-StackState {
    $o = @{ pin = $null; api = $null; web = $null; compose = $false }
    try {
      $j = [IO.File]::ReadAllText($sync.StatePath) | ConvertFrom-Json -AsHashtable
      foreach ($k in 'pin', 'api', 'web') {
        if ($j[$k] -and $j[$k].Pid) { $o[$k] = @{ Pid = [int]$j[$k].Pid; Start = [int64]$j[$k].Start } }
      }
      $o.compose = [bool]$j['compose']
    } catch { }
    $o
  }

  function Step-Files {
    Set-Row files busy 'checking…'
    $repo = $sync.Repo
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Stop-Step files 'Node.js is not on PATH.' }
    # Only what RUNNING the stack reads. Tests and docs are not needed, and
    # fetching them is the likeliest way to wedge a struggling OneDrive.
    $paths = @()
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
      $paths = @(& git.exe -C $repo ls-files 2>$null | Where-Object { $_ -notmatch '(^|/)(test|tests|e2e|__tests__)/|\.(test|spec)\.|^docs/|\.md$' })
    }
    $paths += '.env', 'apps/web/.env.local'
    $onlineOnly = 0x400000 -bor 0x1000   # RECALL_ON_DATA_ACCESS | OFFLINE: an online-only OneDrive file
    $fetch = @(foreach ($rel in $paths) {
        $full = Join-Path $repo $rel
        try { if ([int][IO.File]::GetAttributes($full) -band $onlineOnly) { $full } } catch { }
      })
    if ($fetch.Count) {
      Set-Row files busy "fetching $($fetch.Count) files from OneDrive…"
      foreach ($f in $fetch) {
        Assert-Running
        try { $null = [IO.File]::ReadAllBytes($f) }
        catch { Stop-Step files ("OneDrive isn't handing over the project files (stuck on {0}). Make sure OneDrive is running, then try again." -f [IO.Path]::GetFileName($f)) }
      }
    }
    foreach ($rel in 'docker-compose.yml', 'apps/server/package.json', 'apps/web/package.json', 'packages/db/package.json') {
      if (-not (Test-Path -LiteralPath (Join-Path $repo $rel))) { Stop-Step files "$rel is missing." }
    }
    foreach ($rel in 'apps\server\node_modules\.bin\tsx.cmd', 'apps\web\node_modules\.bin\vite.cmd', 'packages\db\node_modules\.bin\tsx.cmd') {
      if (-not (Test-Path -LiteralPath (Join-Path $repo $rel))) {
        Stop-Step files 'Dependencies are not installed. Run "pnpm install" once while online.'
      }
    }
    Set-Row files ok ($fetch.Count ? "ready (fetched $($fetch.Count) from OneDrive)" : 'ready')
  }

  function Step-Docker {
    $d = $sync.Distro
    Set-Row wsl busy "starting $d…"
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Stop-Step wsl 'WSL is not installed.' }
    $running = @((& wsl.exe -l --running -q 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $sync.WslWasRunning = $running -contains $d
    if (-not (Test-Alive $sync.Owned.pin)) {
      # Something long-lived inside the distro is what stops WSL (and Docker
      # with it) idling out from under the stack.
      $psi = [Diagnostics.ProcessStartInfo]::new('wsl.exe', "-d $d -e sleep infinity")
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      $sync.Owned.pin = Get-ProcessRecord ([Diagnostics.Process]::Start($psi))
      Save-StackState
    }
    Set-Row wsl busy 'waiting for Docker…'
    $script:dockerVersion = ''
    $ready = Wait-Until {
      $r = Invoke-Logged (Get-WslCommand 'docker info --format {{.ServerVersion}}') 30 -Quiet
      if ($r.Code -eq 0) { $script:dockerVersion = Get-LastLine $r.Out; $true } else { $false }
    } 120 2000
    if (-not $ready) { Stop-Step wsl "Docker isn't answering inside WSL ($d). The launcher log has its last words." }
    Set-Row wsl ok "Docker $script:dockerVersion"
  }

  function Get-Health([string]$Service) {
    (Invoke-Logged (Get-WslCommand "docker inspect -f {{.State.Health.Status}} prisms-$Service-1") 30 -Quiet).Out.Trim()
  }

  function Step-Database {
    Set-Row db busy 'starting…'
    $ps = Invoke-Logged (Get-WslCommand 'docker compose ps --status running --services') 60
    $sync.RunningBefore = @($ps.Out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[\w.-]+$' })
    # The containers are this launcher's to stop if it found none running — or
    # found them only because booting WSL brought them back on its own
    # (`restart: unless-stopped`). Once claimed, a claim sticks until a stop.
    if (-not $sync.WslWasRunning -or -not $sync.RunningBefore.Count) { $sync.Owned.compose = $true; Save-StackState }
    $r = Invoke-Logged (Get-WslCommand 'docker compose up -d postgres') 180
    if ($r.Code -ne 0) { Stop-Step db "Docker couldn't start Postgres: $(Get-LastLine $r.Out)" }
    $ready = Wait-Until { (Test-Port $sync.DbPort) -and (Get-Health 'postgres') -eq 'healthy' } 120 1500
    if (-not $ready) { Stop-Step db "Postgres didn't become ready on :$($sync.DbPort)." }
    Set-Row db ok "up on :$($sync.DbPort)"
  }

  function Get-MigrationCount {
    $r = Invoke-Logged (Get-WslCommand 'docker compose exec -T postgres psql -U prisms -d prisms -tAc "select count(*) from drizzle.drizzle_migrations"') 30 -Quiet
    $n = 0
    # -1: no migrations table yet, i.e. a fresh database
    ($r.Code -eq 0 -and [int]::TryParse((Get-LastLine $r.Out), [ref]$n)) ? $n : -1
  }

  function Step-Migrate {
    Set-Row migrate busy 'applying…'
    $before = Get-MigrationCount
    $run = Get-PackageScript migrate 'packages\db' 'db:migrate'
    $r = Invoke-Logged $run.Command 240 @{ PATH = $run.Path; PRISMS_DB_TEST_URL = $null } $run.Dir
    if ($r.Code -ne 0) { Stop-Step migrate "Migrations failed: $(Get-LastLine $r.Out)" }
    $new = (Get-MigrationCount) - [math]::Max($before, 0)
    $sync.SchemaChanged = $new -gt 0
    Set-Row migrate ok ($new -gt 0 ? "applied $new new" : 'up to date')
  }

  function Step-Sync {
    Set-Row sync busy 'starting…'
    $wasUp = $sync.RunningBefore -contains 'powersync'
    $r = Invoke-Logged (Get-WslCommand 'docker compose up -d powersync') 180
    if ($r.Code -ne 0) { Stop-Step sync "Docker couldn't start PowerSync: $(Get-LastLine $r.Out)" }
    if ($wasUp -and $sync.SchemaChanged) {
      Set-Row sync busy 'restarting for the new schema…'
      $null = Invoke-Logged (Get-WslCommand 'docker compose restart powersync') 120
    }
    $probe = "http://127.0.0.1:$($sync.SyncPort)/probes/liveness"
    if (-not (Wait-Until { (Get-HttpStatus $probe 3) -eq 200 } 150 1500)) { Stop-Step sync "PowerSync didn't come up on :$($sync.SyncPort)." }
    Set-Row sync ok "up on :$($sync.SyncPort)"
  }

  # Answering is not enough: it has to be PRISMS answering. Compose's api stub
  # also serves /health (on :3001, wherever .env does not move it), so the API
  # must name itself; the web app must serve the Prisms page.
  function Test-ServerReady([string]$Key) {
    try {
      if ($Key -eq 'api') {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$($sync.ApiPort)/health" -TimeoutSec 10 -NoProxy -ErrorAction Stop
        return $r.service -eq 'prisms-api'
      }
      # the first page load can take a while: Vite transforms on demand
      $r = Invoke-WebRequest -Uri "http://localhost:$($sync.WebPort)/" -TimeoutSec 60 -NoProxy -ErrorAction Stop
      return [bool]($r.Content -match '<title>Prisms</title>')
    } catch { return $false }
  }

  # The API and the web app: both are host processes this launcher owns only
  # if it started them.
  function Step-Server([string]$Key) {
    $isApi = $Key -eq 'api'
    $name = $isApi ? 'The API server' : 'The web app'
    $port = $isApi ? $sync.ApiPort : $sync.WebPort
    $mine = Test-Alive $sync.Owned[$Key]
    if (Test-Port $port) {
      Set-Row $Key busy 'checking…'
      if (Test-ServerReady $Key) { Set-Row $Key ok ($mine ? "up on :$port" : "already running on :$port"); return }
      Stop-Step $Key "Port $port is taken by $(Get-PortOwner $port), which isn't Prisms."
    }
    if ($mine) { Stop-Tree $sync.Owned[$Key].Pid }   # ours, but no longer listening: start it over
    Set-Row $Key busy 'starting…'
    if ($isApi) {
      $run = Get-PackageScript api 'apps\server' 'start'
      $environment = @{
        PATH                        = $run.Path
        # The dev stack's PowerSync key. The gitignored .env carries
        # prod-derived values this PowerSync rejects, and shell env beats .env.
        POWERSYNC_JWT_SECRET        = 'prisms-dev-secret-change-me-32by'
        POWERSYNC_JWT_KID           = 'powersync-dev'
        POWERSYNC_JWT_AUDIENCE      = 'powersync-dev'
        PS_JWT_K_B64URL             = 'cHJpc21zLWRldi1zZWNyZXQtY2hhbmdlLW1lLTMyYnk'
        PORT                        = "$port"
        BETTER_AUTH_URL             = $sync.Url
        BETTER_AUTH_TRUSTED_ORIGINS = $sync.Url
        PRISMS_JOBS_ENABLED         = 'true'
      }
    } else {
      # Exactly :5173. Auth trusts that origin, so a server that drifted to
      # :5174 would be a site nobody can sign in to.
      $run = Get-PackageScript web 'apps\web' 'dev' "--port $port --strictPort"
      # the same PowerSync port compose publishes, so the two cannot disagree
      $environment = @{ PATH = $run.Path; VITE_POWERSYNC_URL = "http://localhost:$($sync.SyncPort)" }
    }
    $log = Join-Path $sync.LogDir "$Key.log"
    $proc = Start-Hidden $run.Command $log $environment $run.Dir
    $sync.Owned[$Key] = Get-ProcessRecord $proc
    Save-StackState
    $ready = Wait-Until { $proc.HasExited -or ((Test-Port $port) -and (Test-ServerReady $Key)) } 180 1000
    if ($proc.HasExited -or -not $ready) {
      if (-not $proc.HasExited) { Stop-Tree $proc.Id }
      $sync.Owned[$Key] = $null
      Save-StackState
      Stop-Step $Key "$name didn't start: $(Get-FailureReason $log)"
    }
    Set-Row $Key ok "up on :$port"
  }

  function Invoke-StackStart {
    $sync.Cancel = $false
    $sync.Owned = Read-StackState
    $sync.StartedAt = Get-Date
    $sync.UpAt = $null
    foreach ($k in $sync.Order) { Set-Row $k pending }
    Set-Phase starting 'Starting Prisms…'
    try {
      Step-Files
      Step-Docker
      Step-Database
      Step-Migrate
      Step-Sync
      Step-Server api
      Step-Server web
      $sync.UpAt = Get-Date
      Set-Phase up 'Prisms is up and running'
    } catch [OperationCanceledException] {
      Write-StackLog 'start cancelled'
    } catch {
      $row = $_.Exception.Data['row']
      if ($row) {
        Set-Row $row fail 'failed'
        Set-Phase failed $_.Exception.Message
      } else {
        Write-StackLog "unexpected: $($_ | Out-String)"
        Set-Phase failed "Unexpected error: $($_.Exception.Message)"
      }
    }
  }

  function Invoke-StackStop {
    $sync.Cancel = $false
    $sync.Owned = Read-StackState
    Set-Phase stopping 'Stopping Prisms…'
    foreach ($k in 'web', 'api') {
      $port = $k -eq 'api' ? $sync.ApiPort : $sync.WebPort
      if (Test-Alive $sync.Owned[$k]) {
        Set-Row $k busy 'stopping…'
        Stop-Tree $sync.Owned[$k].Pid
        Set-Row $k off 'stopped'
      } elseif (Test-Port $port) {
        Set-Row $k warn 'left running (not started here)'
      } else {
        Set-Row $k off 'stopped'
      }
      $sync.Owned[$k] = $null
    }
    Save-StackState
    if ($sync.Owned.compose) {
      Set-Row sync busy 'stopping…'
      Set-Row db busy 'stopping…'
      $null = Invoke-Logged (Get-WslCommand 'docker compose stop') 120
      Set-Row sync off 'stopped'
      Set-Row db off 'stopped'
      $sync.Owned.compose = $false
      Save-StackState
    } else {
      foreach ($k in 'sync', 'db') {
        $port = $k -eq 'db' ? $sync.DbPort : $sync.SyncPort
        if (Test-Port $port) { Set-Row $k warn 'left running (not started here)' } else { Set-Row $k off 'stopped' }
      }
    }
    Set-Row migrate off
    # released last: `docker compose stop` above still needed WSL awake
    if (Test-Alive $sync.Owned.pin) { Stop-Tree $sync.Owned.pin.Pid }
    $sync.Owned.pin = $null
    Save-StackState
    Set-Row wsl off 'released'
    Set-Row files off
    Set-Phase stopped 'Prisms is stopped'
  }

  # After "up", the window keeps telling the truth: a port that stops answering
  # turns its row red within a few seconds.
  function Invoke-StackMonitor {
    $watch = [ordered]@{ db = $sync.DbPort; sync = $sync.SyncPort; api = $sync.ApiPort; web = $sync.WebPort }
    $down = @(foreach ($k in $watch.Keys) {
        if (Test-Port $watch[$k]) {
          if ($sync.Rows[$k].State -ne 'ok') { Set-Row $k ok "up on :$($watch[$k])" }
        } else {
          if ($sync.Rows[$k].State -ne 'fail') { Set-Row $k fail 'not responding' }
          $k
        }
      })
    if (-not $down.Count) {
      if ($sync.Phase -ne 'up') { Set-Phase up 'Prisms is up and running' }
    } elseif ($down.Count -eq $watch.Count) {
      if ($sync.Phase -ne 'down') { Set-Phase down 'Every part of Prisms has stopped responding.' }
    } else {
      $msg = (($down | ForEach-Object { $sync.Labels[$_] }) -join ', ') + ' stopped responding.'
      if ($sync.Phase -ne 'degraded' -or $sync.Message -ne $msg) { Set-Phase degraded $msg }
    }
  }

  function Invoke-EngineLoop {
    $next = [datetime]::MinValue
    while ($true) {
      while ($sync.Queue.Count) {
        $cmd = $sync.Queue.Dequeue()
        if ($cmd -eq 'exit') { return }
        try {
          switch ($cmd) {
            'start' { Invoke-StackStart }
            'stop' { Invoke-StackStop }
            'restart' { Invoke-StackStop; Invoke-StackStart }
          }
        } catch {
          Write-StackLog "unexpected: $($_ | Out-String)"
          Set-Phase failed "Unexpected error: $($_.Exception.Message)"
        }
      }
      if (($sync.Phase -in @('up', 'degraded', 'down')) -and ((Get-Date) -ge $next)) {
        try { Invoke-StackMonitor } catch { Write-StackLog "monitor: $($_.Exception.Message)" }
        $next = (Get-Date).AddSeconds(3)
      }
      Start-Sleep -Milliseconds 200
    }
  }
}
. $Engine

# ── setup ─────────────────────────────────────────────────────────────────────

# Only the two port numbers are read from the gitignored .env — nothing else.
function Read-EnvPort([string]$Name, [int]$Default) {
  try {
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $script:RepoRoot '.env'))) {
      if ($line -match "^\s*$Name\s*=\s*['`"]?(\d+)") { return [int]$Matches[1] }
    }
  } catch { }
  $Default
}

# State lives under the home folder, not AppData. A packaged app (Claude
# Desktop is one) gets a private copy of AppData, so a launch from the desktop
# and a -Stop run from inside such an app would each see their own state file.
function Get-StackStateDir { Join-Path $HOME '.prisms\dev-stack' }

function New-StackSync {
  $stateDir = Get-StackStateDir
  $logDir = Join-Path $stateDir 'logs'
  [void](New-Item -ItemType Directory -Force -Path $logDir)
  $log = Join-Path $logDir 'launcher.log'
  if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) {
    Move-Item -LiteralPath $log -Destination (Join-Path $logDir 'launcher.previous.log') -Force
  }
  $s = [hashtable]::Synchronized(@{})
  $s.Repo = $script:RepoRoot
  $s.Distro = $Distro
  $s.StateDir = $stateDir
  $s.LogDir = $logDir
  $s.StatePath = Join-Path $stateDir 'state.json'
  # compose publishes these host ports from .env; the API and web are fixed
  $s.DbPort = Read-EnvPort 'PRISMS_POSTGRES_PORT' 5432
  $s.SyncPort = Read-EnvPort 'PRISMS_POWERSYNC_PORT' 8080
  $s.ApiPort = 3001
  $s.WebPort = 5173
  $s.Url = 'http://localhost:5173'
  $s.Order = @('files', 'wsl', 'db', 'migrate', 'sync', 'api', 'web')
  $s.Labels = @{
    files = 'Project files'; wsl = 'Docker (WSL)'; db = 'Database'; migrate = 'Migrations'
    sync = 'PowerSync'; api = 'API server'; web = 'Web app'
  }
  $s.Rows = [hashtable]::Synchronized(@{})
  foreach ($k in $s.Order) { $s.Rows[$k] = @{ State = 'pending'; Detail = '' } }
  $s.Queue = [Collections.Queue]::Synchronized([Collections.Queue]::new())
  $s.Phase = 'idle'
  $s.Message = ''
  $s.Version = 0
  $s.Cancel = $false
  $s.StartedAt = $null
  $s.UpAt = $null
  $s.Owned = @{ pin = $null; api = $null; web = $null; compose = $false }
  $s
}

function Start-StackWorker {
  $rs = [runspacefactory]::CreateRunspace()
  $rs.Open()
  $rs.SessionStateProxy.SetVariable('sync', $sync)
  $ps = [powershell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript($Engine.ToString() + [Environment]::NewLine + 'Invoke-EngineLoop')
  @{ PowerShell = $ps; Handle = $ps.BeginInvoke() }
}

# The web app's own icon, as a .ico for the shortcut and the window. An .ico
# may carry PNG frames as they are, so each size is just the PNG re-drawn.
function Get-StackIcon {
  $ico = Join-Path $sync.StateDir 'prisms.ico'
  if (Test-Path -LiteralPath $ico) { return $ico }
  $src = Join-Path $script:RepoRoot 'apps\web\public\icon-512.png'
  if (-not (Test-Path -LiteralPath $src)) { return $null }
  Add-Type -AssemblyName System.Drawing
  $img = [Drawing.Image]::FromFile($src)
  try {
    $frames = foreach ($size in 16, 24, 32, 48, 64, 128, 256) {
      $bmp = [Drawing.Bitmap]::new($size, $size)
      $g = [Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = 'HighQualityBicubic'
      $g.PixelOffsetMode = 'HighQuality'
      $g.DrawImage($img, 0, 0, $size, $size)
      $g.Dispose()
      $ms = [IO.MemoryStream]::new()
      $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      , @($size, $ms.ToArray())
    }
  } finally { $img.Dispose() }
  $out = [IO.MemoryStream]::new()
  $w = [IO.BinaryWriter]::new($out)
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$frames.Count)
  $offset = 6 + 16 * $frames.Count
  foreach ($f in $frames) {
    $w.Write([byte]($f[0] % 256)); $w.Write([byte]($f[0] % 256))   # 256 is written as 0
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$f[1].Length); $w.Write([uint32]$offset)
    $offset += $f[1].Length
  }
  foreach ($f in $frames) { $w.Write([byte[]]$f[1]) }
  $w.Flush()
  [IO.File]::WriteAllBytes($ico, $out.ToArray())
  $ico
}

function Install-StackShortcut {
  $pwshExe = (Get-Process -Id $PID).Path   # the pwsh running this, so the shortcut uses the same one
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Prisms.lnk'
  $ico = Get-StackIcon
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  # conhost --headless: no console window at all, so the status window is the
  # whole UI. Started plainly, Windows Terminal would open an empty tab beside it.
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
  $s.Arguments = '--headless "{0}" -NoProfile -STA -ExecutionPolicy Bypass -File "{1}"' -f $pwshExe, $script:ScriptPath
  $s.WorkingDirectory = $script:RepoRoot
  $s.Description = 'Start the Prisms dev stack (works offline)'
  if ($ico) { $s.IconLocation = "$ico,0" }
  $s.Save()
  Write-Host "Shortcut ready: $lnk" -ForegroundColor Green
  Write-Host 'Double-click it to bring Prisms up.' -ForegroundColor DarkGray
}

# ── the window ────────────────────────────────────────────────────────────────

function New-StackWindow {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $C = @{
    Ink = [Drawing.Color]::FromArgb(17, 24, 39); Dim = [Drawing.Color]::FromArgb(107, 114, 128)
    Line = [Drawing.Color]::FromArgb(229, 231, 235); Soft = [Drawing.Color]::FromArgb(243, 244, 246)
    Blue = [Drawing.Color]::FromArgb(37, 99, 235); Green = [Drawing.Color]::FromArgb(22, 163, 74)
    Amber = [Drawing.Color]::FromArgb(217, 119, 6); Red = [Drawing.Color]::FromArgb(220, 38, 38)
    Grey = [Drawing.Color]::FromArgb(156, 163, 175); White = [Drawing.Color]::White
  }
  $form = [Windows.Forms.Form]::new()
  $form.Text = $script:WindowTitle
  # Laid out by hand at the screen's scale. Fonts are in points and scale on
  # their own; `P` scales the pixel spacing to match.
  $form.AutoScaleMode = 'None'
  $k = $form.DeviceDpi / 96.0
  function Px([double]$v) { [int][math]::Round($v * $k) }
  function Pad([double]$l, [double]$t, [double]$r, [double]$b) { [Windows.Forms.Padding]::new((Px $l), (Px $t), (Px $r), (Px $b)) }
  function New-Label([string]$Text, $Color, $Font) {
    $l = [Windows.Forms.Label]::new()
    $l.Text = $Text
    $l.AutoSize = $true
    $l.ForeColor = $Color
    $l.Font = $Font
    $l.Anchor = 'Left'
    $l.Margin = Pad 0 3 8 3
    $l
  }
  function New-Button([string]$Text) {
    $b = [Windows.Forms.Button]::new()
    $b.Text = $Text
    $b.AutoSize = $true
    $b.AutoSizeMode = 'GrowAndShrink'
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.UseVisualStyleBackColor = $false
    $b.BackColor = $C.Soft
    $b.ForeColor = $C.Ink
    $b.Padding = Pad 10 4 10 4
    $b.Margin = Pad 0 0 8 0
    $b.Cursor = [Windows.Forms.Cursors]::Hand
    $b
  }
  $fBody = [Drawing.Font]::new('Segoe UI', 10)
  $fSmall = [Drawing.Font]::new('Segoe UI', 9)
  # Segoe UI Symbol for the status marks: plain Segoe UI may lack them, and a
  # missing glyph renders as an empty box.
  $fMark = [Drawing.Font]::new('Segoe UI Symbol', 10)

  $form.Font = $fBody
  $form.BackColor = $C.White
  $form.FormBorderStyle = 'FixedSingle'
  $form.MaximizeBox = $false
  $form.StartPosition = 'CenterScreen'
  $form.AutoSize = $true
  $form.AutoSizeMode = 'GrowAndShrink'
  $form.Padding = Pad 0 0 22 16
  $ico = Get-StackIcon
  if ($ico) { try { $form.Icon = [Drawing.Icon]::new($ico) } catch { } }

  $root = [Windows.Forms.TableLayoutPanel]::new()
  $root.AutoSize = $true
  $root.AutoSizeMode = 'GrowAndShrink'
  $root.ColumnCount = 1
  $root.Location = [Drawing.Point]::new((Px 22), (Px 16))
  $root.MinimumSize = [Drawing.Size]::new((Px 400), 0)
  $form.Controls.Add($root)

  $head = [Windows.Forms.FlowLayoutPanel]::new()
  $head.AutoSize = $true
  $head.WrapContents = $false
  $head.Margin = Pad 0 0 0 0
  $png = Join-Path $script:RepoRoot 'apps\web\public\icon-192.png'
  if (Test-Path -LiteralPath $png) {
    $logo = [Windows.Forms.PictureBox]::new()
    $logo.Image = [Drawing.Image]::FromFile($png)
    $logo.SizeMode = 'Zoom'
    $logo.Size = [Drawing.Size]::new((Px 28), (Px 28))
    $logo.Margin = Pad 0 2 10 0
    $head.Controls.Add($logo)
  }
  $title = New-Label 'Prisms' $C.Ink ([Drawing.Font]::new('Segoe UI Semibold', 15))
  $title.Margin = Pad 0 0 6 0
  $tag = New-Label 'local dev stack · works offline' $C.Dim $fSmall
  $tag.Margin = Pad 0 9 0 0
  $head.Controls.AddRange(@($title, $tag))
  $root.Controls.Add($head)

  $grid = [Windows.Forms.TableLayoutPanel]::new()
  $grid.AutoSize = $true
  $grid.ColumnCount = 3
  $grid.Margin = Pad 0 12 0 4
  $rows = @{}
  foreach ($key in $sync.Order) {
    $mark = New-Label '○' $C.Grey $fMark
    $mark.Margin = Pad 0 3 6 3
    $name = New-Label $sync.Labels[$key] $C.Ink $fBody
    $name.MinimumSize = [Drawing.Size]::new((Px 116), 0)
    $detail = New-Label '' $C.Dim $fBody
    $grid.Controls.AddRange(@($mark, $name, $detail))
    $rows[$key] = @{ Mark = $mark; Detail = $detail }
  }
  $root.Controls.Add($grid)

  $rule = [Windows.Forms.Panel]::new()
  $rule.Height = [math]::Max(1, (Px 1))
  $rule.BackColor = $C.Line
  $rule.Anchor = 'Left, Right'
  $rule.Margin = Pad 0 8 0 10
  $root.Controls.Add($rule)

  $bannerRow = [Windows.Forms.FlowLayoutPanel]::new()
  $bannerRow.AutoSize = $true
  $bannerRow.WrapContents = $false
  $bannerRow.Margin = Pad 0 0 0 0
  $glyph = New-Label '' $C.Ink ([Drawing.Font]::new('Segoe UI Symbol', 13))
  $glyph.Margin = Pad 0 0 4 0
  $banner = New-Label '' $C.Ink ([Drawing.Font]::new('Segoe UI Semibold', 12.5))
  $banner.Margin = Pad 0 0 0 0
  $bannerRow.Controls.AddRange(@($glyph, $banner))
  $root.Controls.Add($bannerRow)

  $sub = New-Label '' $C.Dim $fSmall
  $sub.MaximumSize = [Drawing.Size]::new((Px 400), 0)   # long errors wrap instead of widening the window
  $sub.Margin = Pad 0 2 0 0
  $root.Controls.Add($sub)

  $link = [Windows.Forms.LinkLabel]::new()
  $link.Text = $sync.Url
  $link.AutoSize = $true
  $link.Font = [Drawing.Font]::new('Segoe UI', 11.5)
  $link.LinkColor = $C.Blue
  $link.ActiveLinkColor = $C.Blue
  $link.DisabledLinkColor = $C.Grey
  $link.LinkBehavior = 'HoverUnderline'
  $link.Margin = Pad 0 10 0 0
  $link.Enabled = $false
  $root.Controls.Add($link)

  $bar = [Windows.Forms.FlowLayoutPanel]::new()
  $bar.AutoSize = $true
  $bar.WrapContents = $false
  $bar.Margin = Pad 0 16 0 0
  $open = New-Button 'Open Prisms'
  $toggle = New-Button 'Stop'
  $logs = New-Button 'Logs'
  $bar.Controls.AddRange(@($open, $toggle, $logs))
  $root.Controls.Add($bar)

  @{ Form = $form; Rows = $rows; Glyph = $glyph; Banner = $banner; Sub = $sub; Link = $link
    Open = $open; Toggle = $toggle; Logs = $logs; Colors = $C }
}

function Update-StackWindow($Ui) {
  $C = $Ui.Colors
  $tone = @{ pending = $C.Grey; busy = $C.Amber; ok = $C.Green; warn = $C.Amber; fail = $C.Red; off = $C.Grey }
  foreach ($key in $sync.Order) {
    $r = $sync.Rows[$key]
    $row = $Ui.Rows[$key]
    $row.Mark.Text = ($r.State -in @('pending', 'off')) ? '○' : '●'
    $row.Mark.ForeColor = $tone[$r.State]
    $row.Detail.Text = $r.Detail
    $row.Detail.ForeColor = $r.State -eq 'fail' ? $C.Red : $C.Dim
  }
  $phase = $sync.Phase
  $glyph, $text, $color, $sub = switch ($phase) {
    'starting' {
      $s = [int]((Get-Date) - $sync.StartedAt).TotalSeconds
      '', 'Starting Prisms…', $C.Ink, ('Started {0:HH:mm} · {1} s so far' -f $sync.StartedAt, $s)
    }
    'up' {
      $took = [int]($sync.UpAt - $sync.StartedAt).TotalSeconds
      '✓', 'Prisms is up and running', $C.Green, ('Up since {0:HH:mm} · took {1} s to start' -f $sync.UpAt, $took)
    }
    'failed' { '✗', "Prisms didn't start", $C.Red, $sync.Message }
    'degraded' { '⚠', 'Part of Prisms stopped', $C.Amber, $sync.Message }
    'down' { '✗', 'Prisms has stopped', $C.Red, $sync.Message }
    'stopping' { '', 'Stopping Prisms…', $C.Ink, '' }
    'stopped' { '', 'Prisms is stopped', $C.Ink, 'Nothing is running. Start brings it back up.' }
    default { '', 'Getting ready…', $C.Ink, '' }
  }
  $Ui.Glyph.Text = $glyph
  $Ui.Glyph.ForeColor = $color
  $Ui.Glyph.Visible = [bool]$glyph
  $Ui.Banner.Text = $text
  $Ui.Banner.ForeColor = $color
  $Ui.Sub.Text = $sub
  $live = $phase -in 'up', 'degraded'
  $Ui.Link.Enabled = $live
  $Ui.Open.Enabled = $live
  $Ui.Open.BackColor = $live ? $C.Blue : $C.Soft
  $Ui.Open.ForeColor = $live ? $C.White : $C.Grey
  $Ui.Toggle.Text = switch ($phase) {
    { $_ -in 'starting', 'up', 'stopping' } { 'Stop' }
    'degraded' { 'Restart' }
    { $_ -in 'failed', 'down' } { 'Start again' }
    default { 'Start' }
  }
  $Ui.Toggle.Enabled = $phase -ne 'stopping'
}

function Show-StackWindow {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  # before any window exists, or it does nothing
  try { [void][Windows.Forms.Application]::SetHighDpiMode([Windows.Forms.HighDpiMode]::PerMonitorV2) } catch { }
  [Windows.Forms.Application]::EnableVisualStyles()
  $script:Ui = New-StackWindow
  $script:ShownVersion = -1
  $script:LastPhase = ''
  $script:CloseAfterStop = $false
  $script:AllowClose = $false
  $form = $script:Ui.Form

  $script:Ui.Link.Add_LinkClicked({ Start-Process $sync.Url })
  $script:Ui.Open.Add_Click({ Start-Process $sync.Url })
  $script:Ui.Logs.Add_Click({ Start-Process explorer.exe $sync.LogDir })
  $script:Ui.Toggle.Add_Click({
      switch ($sync.Phase) {
        'starting' { $sync.Cancel = $true; $sync.Queue.Enqueue('stop') }
        'up' { $sync.Queue.Enqueue('stop') }
        'degraded' { $sync.Queue.Enqueue('restart') }
        'stopping' { }
        default { $sync.Queue.Enqueue('start') }
      }
    })

  $form.Add_FormClosing({
      param($source, $e)
      if ($script:AllowClose) { return }
      # never stand between Windows and a shutdown, or Task Manager and its job
      if ($e.CloseReason -in 'WindowsShutDown', 'TaskManagerClosing') { return }
      $ours = (Test-Alive $sync.Owned.api) -or (Test-Alive $sync.Owned.web) -or (Test-Alive $sync.Owned.pin)
      if (-not $ours) { return }
      $answer = [Windows.Forms.MessageBox]::Show($script:Ui.Form,
        "Stop Prisms as well?`n`nYes: stop it now.`nNo: leave it running in the background. Open Prisms again to stop it later.",
        'Prisms', 'YesNoCancel', 'Question')
      if ($answer -eq 'Yes') {
        $e.Cancel = $true
        $script:CloseAfterStop = $true
        if ($sync.Phase -eq 'starting') { $sync.Cancel = $true }
        $sync.Queue.Enqueue('stop')
      } elseif ($answer -eq 'Cancel') {
        $e.Cancel = $true
      }
    })

  $timer = [Windows.Forms.Timer]::new()
  $timer.Interval = 200
  $timer.Add_Tick({
      $phase = $sync.Phase
      # while starting, the elapsed seconds tick even when nothing else moved
      if ($sync.Version -ne $script:ShownVersion -or $phase -eq 'starting') {
        $script:ShownVersion = $sync.Version
        Update-StackWindow $script:Ui
        # behind another window, this flashes the taskbar button instead
        if ($phase -eq 'up' -and $script:LastPhase -ne 'up') { $script:Ui.Form.Activate() }
        $script:LastPhase = $phase
      }
      if ($script:CloseAfterStop -and $phase -eq 'stopped') {
        $script:AllowClose = $true
        $script:Ui.Form.Close()
      }
    })
  $form.Add_Shown({ $script:Ui.Form.Activate(); $timer.Start() })
  Update-StackWindow $script:Ui
  [Windows.Forms.Application]::Run($form)
  $timer.Stop()
}

# ── the console ───────────────────────────────────────────────────────────────

function Watch-StackConsole {
  $mark = @{ busy = '…'; ok = '✓'; warn = '!'; fail = '✗'; off = '·' }
  $color = @{ busy = 'DarkYellow'; ok = 'Green'; warn = 'Yellow'; fail = 'Red'; off = 'DarkGray' }
  $shown = @{}
  $stopping = $false
  Write-Host 'Prisms · local dev stack' -ForegroundColor Cyan
  while ($true) {
    foreach ($key in $sync.Order) {
      $r = $sync.Rows[$key]
      $seen = "$($r.State)|$($r.Detail)"
      # a row that merely went blank (stopped, nothing to say) is not news
      $blank = $r.State -eq 'off' -and -not $r.Detail
      if ($r.State -ne 'pending' -and -not $blank -and $shown[$key] -ne $seen) {
        $shown[$key] = $seen
        Write-Host ('  {0} {1,-14} {2}' -f $mark[$r.State], $sync.Labels[$key], $r.Detail) -ForegroundColor $color[$r.State]
      }
    }
    switch ($sync.Phase) {
      'up' {
        if (-not $stopping) {
          $u = $sync.Url
          $esc = [char]27
          Write-Host ''
          Write-Host '  Prisms is up and running: ' -ForegroundColor Green -NoNewline
          # OSC 8: a real link in Windows Terminal; other consoles show the URL
          Write-Host "$esc]8;;$u$esc\$u$esc]8;;$esc\" -ForegroundColor Cyan
          Write-Host '  Press Enter to stop it, or close this window to leave it running.' -ForegroundColor DarkGray
          [void][Console]::ReadLine()
          $stopping = $true
          $sync.Queue.Enqueue('stop')
        }
      }
      'failed' {
        Write-Host "  $($sync.Message)" -ForegroundColor Red
        Write-Host "  Logs: $($sync.LogDir)" -ForegroundColor DarkGray
        return
      }
      'stopped' { if ($stopping) { Write-Host '  Stopped.' -ForegroundColor DarkGray; return } }
    }
    Start-Sleep -Milliseconds 250
  }
}

# ── main ──────────────────────────────────────────────────────────────────────

# A second launch brings the open window forward instead of starting the stack twice.
function Show-ExistingWindow {
  $other = Get-Process -Name pwsh -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -ne $PID -and $_.MainWindowTitle -eq $script:WindowTitle } | Select-Object -First 1
  if ($other) {
    Add-Type -Namespace PrismsStack -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
    [void][PrismsStack.Native]::ShowWindowAsync($other.MainWindowHandle, 9)   # SW_RESTORE
    [void][PrismsStack.Native]::SetForegroundWindow($other.MainWindowHandle)
  } elseif ($NoGui) {
    Write-Host 'Another Prisms launcher is already running.' -ForegroundColor Yellow
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show('Another Prisms launcher is already running (in a console).', 'Prisms')
  }
}

function Invoke-Main {
  $script:sync = New-StackSync
  if ($InstallShortcut) { Install-StackShortcut; return }
  if ($Stop) {
    $sync.Owned = Read-StackState
    $o = $sync.Owned
    if (-not ((Test-Alive $o.api) -or (Test-Alive $o.web) -or (Test-Alive $o.pin) -or $o.compose)) {
      Write-Host 'Nothing to stop: no earlier launch left anything running.'
      return
    }
    Invoke-StackStop
    foreach ($key in 'web', 'api', 'sync', 'db', 'wsl') {
      Write-Host ('  {0,-14} {1}' -f $sync.Labels[$key], $sync.Rows[$key].Detail)
    }
    return
  }
  $created = $false
  $script:Mutex = [Threading.Mutex]::new($true, 'Local\PrismsDevStack', [ref]$created)
  if (-not $created) { Show-ExistingWindow; return }
  $worker = $null
  try {
    $worker = Start-StackWorker
    $sync.Queue.Enqueue('start')
    if ($NoGui) { Watch-StackConsole } else { Show-StackWindow }
  } finally {
    $sync.Queue.Enqueue('exit')
    $done = -not $worker -or $worker.Handle.AsyncWaitHandle.WaitOne(3000)
    try { $script:Mutex.ReleaseMutex() } catch { }
    # Mid-step, the worker may not get to `exit` for minutes, and its thread
    # would hold the process open that long. Servers it already started carry
    # on regardless: they are recorded in the state file for the next launch.
    if (-not $done) { [Environment]::Exit(0) }
  }
}

# Dot-sourced (by a test, say), it only defines the functions above.
if ($MyInvocation.InvocationName -ne '.') {
  try { Invoke-Main }
  catch {
    $msg = "The Prisms launcher hit an error:`n`n$($_.Exception.Message)"
    try {
      $dir = Join-Path (Get-StackStateDir) 'logs'
      [void](New-Item -ItemType Directory -Force -Path $dir)
      [IO.File]::AppendAllText((Join-Path $dir 'launcher.log'), "$(Get-Date -Format s)  fatal: $($_ | Out-String)")
    } catch { }
    if ($NoGui -or $Stop -or $InstallShortcut) { Write-Error $msg }
    else {
      Add-Type -AssemblyName System.Windows.Forms
      [void][Windows.Forms.MessageBox]::Show($msg, 'Prisms', 'OK', 'Error')
    }
    exit 1
  }
}
