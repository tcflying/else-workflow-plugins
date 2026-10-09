<#
.SYNOPSIS
  Register the per-user logon scheduled task that supervises mmx-workflow-pipeline's sidecar.

.DESCRIPTION
  Registers `mmxdwf-sidecar-watchdog` with schtasks (/SC ONLOGON /RL LIMITED): it starts the
  watchdog when this user logs on, runs it with reduced privileges, and needs NO administrator
  rights and NO stored password. The watchdog itself (scripts/sidecar-watchdog.mjs) is a singleton
  and only starts the sidecar when CDP 9331 is reachable, so registering this task cannot start or
  restart MiniMax Code, cannot rebind 4231, and cannot run two sidecars.

  What this script does, in order:
    1. resolves the watchdog .mjs and the node executable as ABSOLUTE paths derived from this
       script's own location (no cwd dependency, no PATH drift at logon time);
    2. refuses to continue if the watchdog file is missing or node is older than v22 (sidecar.mjs
       requires Node >= 22 for native WebSocket);
    3. deletes an existing task with the same name (/F) so re-running this script is idempotent;
    4. creates the task, then runs it once immediately;
    5. prints the registered action back from schtasks /Query so the result can be read back from
       the live system rather than trusted from the request.

  It writes nothing outside Task Scheduler and prints everything it did. Use -NoRun to register
  without the immediate start, and -TaskName to target a different task name.

.EXAMPLE
  powershell.exe -NoProfile -File mmx-workflow-pipeline\scripts\install-watchdog-task.ps1

.EXAMPLE
  powershell.exe -NoProfile -File mmx-workflow-pipeline\scripts\install-watchdog-task.ps1 -NoRun
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'mmxdwf-sidecar-watchdog',
  [switch]$NoRun
)

$ErrorActionPreference = 'Stop'

$WatchdogMjs = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'sidecar-watchdog.mjs'))
$Schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'

Write-Host "[watchdog-task] script        : $PSCommandPath"
Write-Host "[watchdog-task] watchdog .mjs : $WatchdogMjs"

if (-not (Test-Path -LiteralPath $Schtasks)) {
  throw "schtasks.exe not found at $Schtasks"
}
if (-not (Test-Path -LiteralPath $WatchdogMjs)) {
  throw "watchdog script not found: $WatchdogMjs (the task would start nothing)"
}

# ---- node resolution: absolute, version-checked ---------------------------
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $nodeCommand) { throw 'node was not found on PATH; the watchdog cannot be registered without a node executable.' }
$NodeExe = $nodeCommand.Source
if (-not $NodeExe) { $NodeExe = $nodeCommand.Path }
$NodeVersion = (& $NodeExe --version) 2>&1 | Select-Object -First 1
$NodeMajor = 0
if ($NodeVersion -match '^v?(\d+)\.') { $NodeMajor = [int]$Matches[1] }
if ($NodeMajor -lt 22) {
  throw "node $NodeVersion is too old for sidecar.mjs (requires >= 22, native WebSocket): $NodeExe"
}
Write-Host "[watchdog-task] node          : $NodeExe ($NodeVersion)"

# The /TR payload. Both halves are quoted: the repo path and the node install path may contain
# spaces, and schtasks keeps the whole string as a single command line.
$TaskRun = '"{0}" "{1}"' -f $NodeExe, $WatchdogMjs
Write-Host "[watchdog-task] action        : $TaskRun"

function Quote-NativeArgument {
  <#
    MS CRT / CommandLineToArgvW quoting. schtasks re-parses its own command line, so a /TR value
    like `"C:\Program Files\nodejs\node.exe" "G:\repo\sidecar-watchdog.mjs"` MUST arrive as a single
    argv element with its inner quotes backslash-escaped. Verified failure without this: schtasks
    reports "invalid argument - 'G:\repo\sidecar-watchdog.mjs'" because the value splits at the space.
  #>
  param([string]$Value)
  if ($null -eq $Value) { return '""' }
  if ($Value -eq '') { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\*)$', '$1$1'
  return '"' + $escaped + '"'
}

function Invoke-Schtasks {
  param([string[]]$Arguments, [string]$Label)
  # One hand-built command line: PowerShell's own native-argument marshalling mangles embedded
  # quotes, so the exact bytes are assembled here and handed to Start-Process verbatim.
  $commandLine = (($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' ')
  Write-Host "[watchdog-task] $Label cmd     : schtasks.exe $commandLine"
  $stdout = [System.IO.Path]::GetTempFileName()
  $stderr = [System.IO.Path]::GetTempFileName()
  try {
    $proc = Start-Process -FilePath $Schtasks -ArgumentList $commandLine -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $out = (Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue)
    $err = (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)
    if ($out) { Write-Host "[watchdog-task] $Label stdout: $($out.Trim())" }
    if ($err) { Write-Host "[watchdog-task] $Label stderr: $($err.Trim())" }
    Write-Host "[watchdog-task] $Label exit  : $($proc.ExitCode)"
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; StdOut = [string]$out; StdErr = [string]$err }
  }
  finally {
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  }
}

# ---- 1. drop an existing task of the same name ---------------------------
$existing = Invoke-Schtasks -Arguments @('/Query', '/TN', $TaskName) -Label 'query-before'
if ($existing.ExitCode -eq 0) {
  Write-Host "[watchdog-task] task '$TaskName' already exists — deleting it first so re-registration is idempotent."
  $deleted = Invoke-Schtasks -Arguments @('/Delete', '/TN', $TaskName, '/F') -Label 'delete-old'
  if ($deleted.ExitCode -ne 0) { throw "could not delete the existing task '$TaskName' (schtasks exit $($deleted.ExitCode))" }
} else {
  Write-Host "[watchdog-task] no existing task '$TaskName' (schtasks query exit $($existing.ExitCode))"
}

# ---- 2. create (per-user, reduced privileges, no password) ---------------
$created = Invoke-Schtasks -Arguments @('/Create', '/TN', $TaskName, '/TR', $TaskRun, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F') -Label 'create'
if ($created.ExitCode -ne 0) {
  throw "schtasks /Create failed (exit $($created.ExitCode)). Registering the task needs no admin rights; if the message mentions access denied, run this from an elevated prompt OR register the action as a shortcut in the user's Startup folder instead."
}

# ---- 3. run it once now ---------------------------------------------------
if (-not $NoRun) {
  $run = Invoke-Schtasks -Arguments @('/Run', '/TN', $TaskName) -Label 'run-now'
  if ($run.ExitCode -ne 0) { Write-Warning "the task was created but 'schtasks /Run' failed (exit $($run.ExitCode)); it will still start at next logon." }
}

# ---- 4. read the registration back from the live system -------------------
$verify = Invoke-Schtasks -Arguments @('/Query', '/TN', $TaskName, '/FO', 'LIST', '/V') -Label 'verify'
if ($verify.ExitCode -ne 0) { Write-Warning "the task could not be queried back (exit $($verify.ExitCode)); registration is UNVERIFIED." }

Write-Host "[watchdog-task] DONE task='$TaskName' watchdog='$WatchdogMjs' node='$NodeExe'"
Write-Host "[watchdog-task] state file: $(Join-Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($WatchdogMjs))) 'logs')"
Write-Host "[watchdog-task] check with: node '$WatchdogMjs' --once"
exit 0
