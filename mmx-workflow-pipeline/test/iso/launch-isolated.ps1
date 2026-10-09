#Requires -Version 7.0
<#
.SYNOPSIS
  Launch an ISOLATED MiniMax Code instance for UI-isolation acceptance. Authored only — NOT RUN by
  the test author. Read the safety notes before executing.

.DESCRIPTION
  Starts the real exe with an isolated --user-data-dir and a NON-production debug port, and gives the
  CHILD PROCESS ONLY two environment overrides (MINIMAX_DATA_DIR, MAVIS_DATA_DIR) pointing inside the
  project's own artifacts directory.

  What this script guarantees:
    * it refuses to run unless the exe exists and the profile/runtime directories stay inside
      mmx-workflow-pipeline/test/artifacts/ui-isolation (no path escape, ever);
    * it refuses to start if anything is already listening on the debug port, or if an isolated
      instance recorded by this script is still alive (duplicate start refused);
    * it reads the production listener snapshot BEFORE and AFTER and prints both, so a reviewer can
      see the main instance was not disturbed. The production PID is READ LIVE, never hardcoded;
    * it copies NO production runtime, auth, config or session data, changes NO default model,
      performs NO login, and starts NO business workflow;
    * it never kills, never stops, never reloads and never runs with ExecutionPolicy Bypass /
      Unblock-File. Stopping the instance is the project lead's action, through process-control;
    * it only sets the two variables on the child ProcessStartInfo — the host's own environment is
      untouched and nothing persistent is written.

  HONEST LIMIT (read before trusting the output):
    MINIMAX_DATA_DIR / MAVIS_DATA_DIR come from the official CLI documentation
    (https://agent.minimaxi.com/docs/cli/configuration.md). That documents the CLI, NOT the Desktop
    app. --user-data-dir isolates Chromium/Electron profile state; it does NOT by itself prove the
    app's backend runtime/auth is separated.

  WHAT THE REPORT NOW CONTAINS:
    Everything above the observation block is a REQUEST — what this script asked for. Everything the
    script writes under `observed` is an OBSERVATION read back from the live system after the start:
    the Win32_Process row for the launched pid (creation time, image, command line), the pid that
    owns the debug port at that moment, and the newest write under the runtime data directory.
    `backendIsolationProven` is written TRUE only when every one of those observations was obtained
    and agrees with the request. If any of them cannot be read, the flag stays false and the reason
    is listed in `backendIsolationReasons`. It is never set true on the strength of the request alone.

  AFTER START, the project lead still decides whether to inject. The gate that consumes this report
  is test/iso/iso-observer.mjs (wired into the sidecar by --observe), which re-reads the LIVE system
  every time it is asked. If backendIsolationProven is false, STOP — do not inject.

.EXAMPLE
  pwsh -NoProfile -File mmx-workflow-pipeline/test/iso/launch-isolated.ps1
  pwsh -NoProfile -File mmx-workflow-pipeline/test/iso/launch-isolated.ps1 -DebugPort 19331
#>
[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$DebugPort = 19331,
  [string]$ExePath = 'G:\MiniMax\MiniMax Code\MiniMax Code.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Production endpoints that must never be touched by this harness.
$ProductionApiPort = 4231
$ProductionCdpPort = 9331
$ControlPlanePort = 19080

$IsoDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\artifacts\ui-isolation'))
$ProfileDir = [System.IO.Path]::GetFullPath((Join-Path $IsoDir 'electron-profile'))
$RuntimeDir = [System.IO.Path]::GetFullPath((Join-Path $IsoDir 'runtime-data'))
$StateFile = Join-Path $IsoDir 'launch-isolated.json'

function Stop-With([string]$Message) {
  Write-Error "launch-isolated REFUSED: $Message"
  exit 2
}

# --- preflight: exe ----------------------------------------------------------
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { Stop-With "exe not found: $ExePath" }
$ResolvedExe = (Resolve-Path -LiteralPath $ExePath).Path

# --- preflight: isolation invariants -----------------------------------------
if ($DebugPort -in @($ProductionApiPort, $ProductionCdpPort, $ControlPlanePort)) {
  Stop-With "debug port $DebugPort is a reserved production/control-plane port"
}
# Every level from each directory up to the artifacts root (itself included) must be a plain
# directory. A junction anywhere on that chain would let --user-data-dir or the runtime data
# silently land outside the project, so this is checked BEFORE anything is created.
# Every level from each directory up to the PROJECT ROOT (itself included) must be a plain
# directory. A junction anywhere on that chain would let --user-data-dir or the runtime data
# silently land outside the project, so this is checked BEFORE anything is created. The walk stops
# at the project root, not at the artifacts dir: a junction ABOVE the artifacts dir would otherwise
# hide behind a sub-root check.
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
function Test-IsUnder([string]$Path, [string]$Root) {
  $p = [System.IO.Path]::GetFullPath($Path)
  $r = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  # Strict separator-delimited containment: a bare StartsWith would accept a sibling like
  # `...\ui-isolation-evil` for the root `...\ui-isolation`.
  return $p.Equals([System.IO.Path]::GetFullPath($Root), [System.StringComparison]::OrdinalIgnoreCase) -or
         $p.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)
}
function Assert-NoLink([string]$Path, [string]$StopAt) {
  $current = [System.IO.Path]::GetFullPath($Path)
  $stop = [System.IO.Path]::GetFullPath($StopAt)
  for ($i = 0; $i -le 64; $i++) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.LinkType) { Stop-With "refusing a link/junction on the isolation path: $current ($($item.LinkType))" }
    }
    if ($current.Equals($stop, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { return }
    $current = [System.IO.Path]::GetFullPath($parent)
  }
}
foreach ($dir in @($IsoDir, $ProfileDir, $RuntimeDir)) {
  if (-not (Test-IsUnder $dir $IsoDir)) {
    Stop-With "directory escape refused: $dir is not under $IsoDir"
  }
  Assert-NoLink -Path $dir -StopAt $ProjectRoot
}
foreach ($dir in @($ProfileDir, $RuntimeDir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

function Get-Listener([int]$Port) {
  $rows = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $rows) { return @() }
  return @($rows | ForEach-Object {
    [pscustomobject]@{ localAddress = $_.LocalAddress; localPort = $_.LocalPort; owningPid = $_.OwningProcess }
  })
}

# --- read-only observation helpers ----------------------------------------------
# None of these starts, stops, kills, injects into or otherwise disturbs a process. They read one
# Win32_Process row, one listener table, and a bounded directory listing, and nothing else.

# ONE process row for ONE pid. Returns $null when the process cannot be seen at all, which is a
# real answer (it exited, or it belongs to another user and cannot be read) and not a value to guess.
function Get-ProcessObservation([int]$ProcessId) {
  $row = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue)[0]
  if ($null -eq $row) { return $null }
  return [pscustomobject]@{
    processId      = [int]$row.ProcessId
    creationDate   = $(if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') } else { '' })
    executablePath = [string]$row.ExecutablePath
    commandLine    = [string]$row.CommandLine
  }
}

# The value a flag was actually started with, read out of the LIVE command line. Tokenised rather
# than regex-scanned, because ProcessStartInfo.ArgumentList quotes a whole argument when it holds a
# space: `"--user-data-dir=C:\a b\profile"`. Returns '' when the flag is absent.
function Get-CommandLineFlag([string]$CommandLine, [string]$Flag) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return '' }
  $tokens = @([regex]::Matches($CommandLine, '"(?:[^"\\]|\\.)*"|\S+') | ForEach-Object { $_.Value.Trim('"') })
  for ($i = 0; $i -lt $tokens.Count; $i++) {
    if ($tokens[$i].StartsWith("$Flag=", [System.StringComparison]::OrdinalIgnoreCase)) {
      return $tokens[$i].Substring($Flag.Length + 1)
    }
    if ($tokens[$i].Equals($Flag, [System.StringComparison]::OrdinalIgnoreCase) -and ($i + 1) -lt $tokens.Count) {
      return $tokens[$i + 1]
    }
  }
  return ''
}

# One time base for every instant compared in this script. [datetime]::Parse() on an ISO-8601
# string that ends in 'Z' returns a DateTime whose Kind is Local and whose value is the LOCAL wall
# clock — 2026-10-09T08:29:02.8710000Z parses to 16:29:02.871+08:00 on this host. PowerShell's -lt
# and -ge compare the underlying ticks and do NOT normalise Kind, so such a value compared against a
# LastWriteTimeUtc (Kind Utc, ticks exactly as written) invents the machine's UTC offset as a drift.
# That is not hypothetical: the first real run reported a write 0.8 s AFTER the process start as
# "predates the process start" and refused backendIsolationProven, because 08:29 < 16:29.
# RoundtripKind keeps the instant the string names; ToUniversalTime() normalises a string that
# carries an explicit offset instead of a 'Z'.
function ConvertTo-UtcInstant([string]$IsoText) {
  if ([string]::IsNullOrWhiteSpace($IsoText)) { return $null }
  $parsed = [datetime]::Parse($IsoText.Trim(), [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
  return $parsed.ToUniversalTime()
}

# The newest write at or below $Dir, as a Kind=Utc [datetime], or $null when $Dir is not there.
# Depth 2 on purpose, and deliberately identical to newestWriteMs() in iso-observer.mjs — that is the
# gate which consumes this report, and two different walks would produce two different verdicts on the
# same directory. The directory's OWN mtime participates on both sides: the launcher creates the
# directory before the app starts, and that creation is precisely the race the 2 s tolerance exists to
# absorb, so it may only ever pass inside that window. A directory left over from an hour ago cannot.
function Get-NewestWriteUtc([string]$Dir) {
  $root = Get-Item -LiteralPath $Dir -ErrorAction SilentlyContinue
  if ($null -eq $root) { return $null }
  $newest = $root.LastWriteTimeUtc
  foreach ($item in @(Get-ChildItem -LiteralPath $Dir -Recurse -Depth 2 -Force -ErrorAction SilentlyContinue)) {
    if ($item.LastWriteTimeUtc -gt $newest) { $newest = $item.LastWriteTimeUtc }
  }
  return $newest
}

# --- preflight: a live isolated instance from an earlier run? -----------------
if (Test-Path -LiteralPath $StateFile) {
  try {
    $prior = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $alive = Get-Process -Id ([int]$prior.pid) -ErrorAction SilentlyContinue
    if ($alive) {
      $same = ([datetime]$prior.startTime).ToString('o') -eq $alive.StartTime.ToUniversalTime().ToString('o')
      if ($same) { Stop-With "an isolated instance from this script is already running (pid $($prior.pid), started $($prior.startTime)); stop it deliberately before starting another" }
    }
  } catch { }
}

# --- preflight: the debug port must be free (listener table + real bind) -----
$before = [pscustomobject]@{
  debugPort = $DebugPort; debug = @(Get-Listener $DebugPort)
  productionCdp = @(Get-Listener $ProductionCdpPort)
  productionApi = @(Get-Listener $ProductionApiPort)
  controlPlane = @(Get-Listener $ControlPlanePort)
}
if ($before.debug.Count -gt 0) {
  Stop-With "port $DebugPort is already in use by pid(s) $($before.debug.owningPid -join ','); refusing to attach to or disturb it"
}
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $DebugPort)
try { $probe.Start() } catch { Stop-With "port $DebugPort could not be bound for the isolated instance: $($_.Exception.Message)" }
finally { try { $probe.Stop() } catch { } }

# --- launch: child-only environment overrides --------------------------------
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $ResolvedExe
$psi.UseShellExecute = $false
$psi.WorkingDirectory = $ProfileDir
foreach ($a in @(
  "--user-data-dir=$ProfileDir",
  "--remote-debugging-port=$DebugPort",
  '--remote-debugging-address=127.0.0.1'
)) { [void]$psi.ArgumentList.Add($a) }

# Child process only. The host environment is not modified and nothing is persisted.
$psi.Environment['MINIMAX_DATA_DIR'] = $RuntimeDir
$psi.Environment['MAVIS_DATA_DIR'] = $RuntimeDir
foreach ($v in @('MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR')) {
  Write-Host "[launch-isolated] child $v = $($psi.Environment[$v])"
}

$proc = [System.Diagnostics.Process]::Start($psi)
if (-not $proc) { Stop-With 'Process.Start returned nothing' }

Start-Sleep -Seconds 2
$proc.Refresh()
# The start time is taken from the PROCESS, not from a clock reading captured before the launch.
# The duplicate-start guard compares this exact value against the live process, so a pre-launch
# timestamp could never match and would let a second instance start on top of the first.
# $processStartUtc is that SAME instant kept as a Kind=Utc DateTime. Every comparison below is
# UTC against UTC, taken from this value directly — nothing re-derives it from the string form.
$processStartUtc = $proc.StartTime.ToUniversalTime()
$startedAt = $processStartUtc.ToString('o')

# --- LIVE IDENTITY OBSERVATION ---------------------------------------------------
# Everything above is a request. Everything below is read back from the live system, and
# backendIsolationProven is true ONLY when all of it was obtained and agrees. Nothing here is
# inferred from what was asked for: an unreadable value is a reason to stay false, not a value to
# fill in.
$reasons = New-Object System.Collections.Generic.List[string]

$procObs = Get-ProcessObservation -ProcessId $proc.Id
$observedExe = ''
$observedStart = ''
$observedUserData = ''
$observedCommandLine = ''
if ($null -eq $procObs) {
  $reasons.Add("no live Win32_Process row could be read for pid $($proc.Id); the process cannot be identified")
} else {
  $observedExe = [string]$procObs.executablePath
  $observedStart = [string]$procObs.creationDate
  $observedCommandLine = [string]$procObs.commandLine
  if (-not $observedExe) {
    $reasons.Add("ExecutablePath of pid $($proc.Id) is empty; the process image cannot be read, so identity is unproven")
  } elseif (-not $observedExe.Equals($ResolvedExe, [System.StringComparison]::OrdinalIgnoreCase)) {
    $reasons.Add("the live process image is $observedExe, not the launched $ResolvedExe")
  }
  if (-not $observedStart) {
    $reasons.Add("CreationDate of pid $($proc.Id) is empty; the start time cannot be established")
  } else {
    $observedStartUtc = ConvertTo-UtcInstant $observedStart
    if ($null -eq $observedStartUtc) {
      $reasons.Add("CreationDate of pid $($proc.Id) ($observedStart) is not a parseable instant; the start time cannot be established")
    } else {
      # Cross-check the two independent clocks: Process.StartTime and Win32_Process.CreationDate
      # describe the same instant, so a real disagreement means one of them is describing something
      # else. 1ms absorbs the conversion rounding only. Both sides are the UTC instant: compared as
      # raw DateTime values, the host's offset would read as an 8 hour disagreement between two
      # clocks that in fact agree.
      $drift = [math]::Abs(($observedStartUtc - $processStartUtc).TotalMilliseconds)
      if ($drift -gt 1) { $reasons.Add("the live creation time ($observedStart) disagrees with Process.StartTime ($startedAt) by $drift ms") }
    }
  }
  $observedUserData = Get-CommandLineFlag $observedCommandLine '--user-data-dir'
  if (-not $observedUserData) {
    $reasons.Add('the live command line carries no --user-data-dir argument, so the actual userDataDir cannot be observed')
  } elseif (-not ([System.IO.Path]::GetFullPath($observedUserData)).Equals($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    $reasons.Add("the live --user-data-dir is $observedUserData, not the requested $ProfileDir")
  }
  $livePortText = Get-CommandLineFlag $observedCommandLine '--remote-debugging-port'
  if (-not $livePortText) {
    $reasons.Add('the live command line carries no --remote-debugging-port argument, so this process cannot be shown to serve the port under test')
  } elseif ([int]$livePortText -ne $DebugPort) {
    $reasons.Add("the live process was started with --remote-debugging-port=$livePortText, not $DebugPort")
  }
}

# The debug port takes a few seconds to bind. Bounded wait, read-only: Get-NetTCPConnection is a
# table query, nothing is probed, connected to or bound by this loop.
$observedOwners = @()
$ownerDeadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $ownerDeadline) {
  $observedOwners = @(Get-Listener $DebugPort)
  if (@($observedOwners | Where-Object { $_.owningPid -eq $proc.Id }).Count -gt 0) { break }
  Start-Sleep -Milliseconds 500
}
$observedOwnerPid = $null
if ($observedOwners.Count -eq 0) {
  $reasons.Add("nothing is listening on the debug port $DebugPort right now")
} else {
  foreach ($row in $observedOwners) {
    if ($row.localAddress -ne '127.0.0.1' -and $row.localAddress -ne '::1') {
      $reasons.Add("the debug port $DebugPort is listening on $($row.localAddress), not on loopback")
    }
    if ($row.owningPid -ne $proc.Id) {
      $reasons.Add("the debug port $DebugPort is owned by pid $($row.owningPid), not by the launched pid $($proc.Id)")
    }
    if ($null -eq $observedOwnerPid) { $observedOwnerPid = [int]$row.owningPid }
  }
}

# Runtime data: the launcher creates $RuntimeDir before the app starts, so the directory merely
# existing proves nothing. The proof is a write NEWER than this process's start. Same predicate, same
# direction and same slack as iso-observer.mjs, which is the gate that consumes this report:
# newest >= start - 2000 ms. Both sides are UTC, and the verdict is computed ONCE here and written to
# the report below, so the reason and the field can never disagree with each other.
$observedRuntimeWrite = Get-NewestWriteUtc -Dir $RuntimeDir
$runtimeWriteAfterStart = ($null -ne $observedRuntimeWrite) -and
                          ($observedRuntimeWrite -ge $processStartUtc.AddSeconds(-2))
if ($null -eq $observedRuntimeWrite) {
  $reasons.Add("the runtime data directory does not exist: $RuntimeDir")
} elseif (-not $runtimeWriteAfterStart) {
  $reasons.Add("the newest write under $RuntimeDir is $($observedRuntimeWrite.ToString('o')), which is more than 2 s older than the process start $startedAt; it may be left over from an earlier run")
}

$backendIsolationProven = ($reasons.Count -eq 0)

$after = [pscustomobject]@{
  debugPort = $DebugPort; debug = @(Get-Listener $DebugPort)
  productionCdp = @(Get-Listener $ProductionCdpPort)
  productionApi = @(Get-Listener $ProductionApiPort)
  controlPlane = @(Get-Listener $ControlPlanePort)
}

$report = [pscustomobject]@{
  kind = 'mmx-ui-isolation-instance'
  isolated = $true
  # True ONLY when every observation above was obtained and agreed. The injector gate treats it as
  # necessary but not sufficient: it additionally requires its own live observation.
  backendIsolationProven = $backendIsolationProven
  backendIsolationReasons = @($reasons.ToArray())
  pid = $proc.Id
  processName = $proc.ProcessName
  # The OBSERVED values, not the requested ones. When an observation could not be made the field is
  # null rather than a plausible-looking placeholder, so nothing downstream can mistake a request
  # for an observation.
  startTime = $(if ($observedStart) { $observedStart } else { $startedAt })
  startTimeSource = 'Win32_Process.CreationDate, cross-checked against Process.StartTime'
  exe = $(if ($observedExe) { $observedExe } else { $null })
  arguments = @($psi.ArgumentList)
  userDataDir = $(if ($observedUserData) { $observedUserData } else { $null })
  runtimeDataDir = $RuntimeDir
  debugPort = $DebugPort
  observed = [pscustomobject]@{
    observedAt = (Get-Date).ToUniversalTime().ToString('o')
    pid = $proc.Id
    startTimeUtc = $(if ($observedStart) { $observedStart } else { $null })
    exe = $(if ($observedExe) { $observedExe } else { $null })
    commandLine = $(if ($observedCommandLine) { $observedCommandLine } else { $null })
    userDataDir = $(if ($observedUserData) { $observedUserData } else { $null })
    debugPort = $DebugPort
    debugPortOwnerPid = $observedOwnerPid
    runtimeDataDir = $RuntimeDir
    runtimeDataWrittenAfterStart = $runtimeWriteAfterStart
    runtimeDataNewestWriteUtc = $(if ($observedRuntimeWrite) { $observedRuntimeWrite.ToString('o') } else { $null })
  }
  requested = [pscustomobject]@{
    userDataDir = $ProfileDir
    runtimeDataDir = $RuntimeDir
    debugPort = $DebugPort
    childEnvOverrides = @{ MINIMAX_DATA_DIR = $RuntimeDir; MAVIS_DATA_DIR = $RuntimeDir }
  }
  childEnvOverrides = @{ MINIMAX_DATA_DIR = $RuntimeDir; MAVIS_DATA_DIR = $RuntimeDir }
  copiedProductionData = $false
  changedDefaultModel = $false
  performedLogin = $false
  listenerSnapshotBefore = $before
  listenerSnapshotAfter = $after
  nextStep = $(if ($backendIsolationProven) {
    'backendIsolationProven=true. This is necessary but NOT sufficient: the sidecar additionally re-observes the live identity on every attach. Start it with --observe pointing at this same file. If anything below is false, stop and do not inject.'
  } else {
    'backendIsolationProven=false with the reasons listed above. This run proves nothing: STOP and do not inject.'
  })
  note = 'This script never kills, stops or reloads anything.'
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StateFile -Encoding utf8
$report | ConvertTo-Json -Depth 6
Write-Host "[launch-isolated] isolated instance pid=$($proc.Id) debugPort=$DebugPort (not stopped by this script)"
Write-Host "[launch-isolated] observed: exe=$($report.exe) startTime=$($report.startTime) debugPortOwnerPid=$($report.observed.debugPortOwnerPid) runtimeNewestWrite=$($report.observed.runtimeDataNewestWriteUtc)"
Write-Host "[launch-isolated] backendIsolationProven=$($report.backendIsolationProven)"
foreach ($why in @($report.backendIsolationReasons)) { Write-Host "[launch-isolated]   unproven: $why" }
