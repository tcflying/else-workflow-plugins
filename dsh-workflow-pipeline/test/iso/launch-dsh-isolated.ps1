#Requires -Version 7.0
<#
.SYNOPSIS
  Launch an ISOLATED DSH Desktop 2.0.17 instance for workflow-pipeline 0.2.7 acceptance.
  Separate user-data-dir + separate DSH_HOME + non-production CDP port. Read-only toward
  the production home; refuses if the debug port is busy or the production home would be touched.
#>
[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)][int]$DebugPort = 19432,
  [string]$ExePath = 'C:\Program Files\DSH Desktop\DSH Desktop.exe',
  [string]$ArtifactsName = 'dsh020'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$art = "G:\mmx-project\zcode动态工作流-原else\dsh-workflow-pipeline\test\artifacts\$ArtifactsName"
$userData = Join-Path $art 'electron-profile'
$homeDir  = Join-Path $art 'home'

if (-not (Test-Path $ExePath)) { throw "exe missing: $ExePath" }
$portBusy = Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue
if ($portBusy) { throw "debug port $DebugPort already listening (pid $($portBusy[0].OwningProcess))" }
foreach ($d in @($userData, $homeDir)) {
  $full = [System.IO.Path]::GetFullPath($d)
  if (-not $full.StartsWith($art, [System.StringComparison]::OrdinalIgnoreCase)) { throw "path escape: $full" }
}
New-Item -ItemType Directory -Force -Path $userData, $homeDir | Out-Null

# production home must stay untouched: assert it by snapshotting the production profiles dir mtime later
$prodProfiles = "$env:APPDATA\DSH Desktop\profiles"
$prodBefore = if (Test-Path $prodProfiles) { (Get-Item $prodProfiles).LastWriteTimeUtc } else { $null }

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $ExePath
$psi.Arguments = "--user-data-dir=`"$userData`" --remote-debugging-port=$DebugPort --remote-debugging-address=127.0.0.1 --no-first-run"
$psi.UseShellExecute = $false
# The dev shell inherits Git Bash's http_proxy=127.0.0.1:7890; the 12:36/12:42 boots both
# died with "renderer boot failed (plugins: Unknown client plugin)" and the log blamed
# "outbound proxy ... source: environment http_proxy". A pristine profile failed the same
# way BEFORE the plugin was installed, so the env, not the plugin, is the variable.
foreach ($v in @('http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','all_proxy','ALL_PROXY')) { $psi.EnvironmentVariables[$v] = $null }
$psi.EnvironmentVariables['NO_PROXY'] = '127.0.0.1,localhost'
$psi.EnvironmentVariables['DSH_HOME'] = $homeDir
$null = [System.Diagnostics.Process]::Start($psi)

# wait for CDP
$up = $false
foreach ($i in 1..30) {
  Start-Sleep -Milliseconds 1000
  try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 2; $up = $true; break } catch {}
}
$prodAfter = if (Test-Path $prodProfiles) { (Get-Item $prodProfiles).LastWriteTimeUtc } else { $null }
$prodUntouched = ($prodBefore -eq $prodAfter)

[pscustomobject]@{
  debugPort = $DebugPort
  cdpUp = $up
  userDataDir = $userData
  dshHome = $homeDir
  prodProfilesUntouched = $prodUntouched
  observedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $art 'launch-report.json') -Encoding utf8
[pscustomobject]@{ debugPort = $DebugPort; cdpUp = $up; prodProfilesUntouched = $prodUntouched } | ConvertTo-Json
