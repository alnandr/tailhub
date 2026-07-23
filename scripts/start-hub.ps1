<#
.SYNOPSIS
  Start the Tailhub hub in background mode (survives closing this terminal).

.DESCRIPTION
  1) Builds the workspace (unless -SkipBuild)
  2) Resolves the admin token: -Token / TAILHUB_TOKEN env -> data-dir token file -> generated
  3) Starts the hub as a hidden detached process (WMI launch so IDE/agent
     terminals that kill job-object children cannot take the hub down with them)
  4) Waits for /health and records the PID in scripts\.hub-pid

.EXAMPLE
  .\scripts\start-hub.ps1
.EXAMPLE
  .\scripts\start-hub.ps1 -SkipBuild -Port 4747
#>
param(
  [switch]$SkipBuild,
  [int]$Port = $(if ($env:TAILHUB_PORT) { [int]$env:TAILHUB_PORT } else { 4747 }),
  [string]$BindHost = $(if ($env:TAILHUB_HOST) { $env:TAILHUB_HOST } else { '127.0.0.1' }),
  [string]$DataDir = $(if ($env:TAILHUB_DATA_DIR) { $env:TAILHUB_DATA_DIR } else { Join-Path $HOME '.tailhub' }),
  [string]$Token = $env:TAILHUB_TOKEN
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'package.json'))) {
  throw "Could not find package.json above $PSScriptRoot"
}
Set-Location $Root

# Lock a file/dir down to the current user + SYSTEM only. The launcher and logs
# carry the admin token in cleartext; without this they inherit the repo tree's
# permissive ACLs, letting any local user read the token — and, since the logon
# task executes run-hub.cmd, letting a user with Modify hijack it. Directories
# get inheritable ACEs so files created inside them are owner-only too.
function Set-OwnerOnlyAcl {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $meSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
  $flags = if ((Get-Item -LiteralPath $Path).PSIsContainer) { '(OI)(CI)F' } else { 'F' }
  & icacls $Path /inheritance:r /grant:r "*${meSid}:$flags" "*S-1-5-18:$flags" > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: could not restrict permissions on $Path (icacls exit $LASTEXITCODE)." -ForegroundColor DarkYellow
  }
}

$pidFile = Join-Path $PSScriptRoot '.hub-pid'
$logDir = Join-Path $PSScriptRoot 'hub-logs'
$launchDir = Join-Path $PSScriptRoot 'hub-launch'
New-Item -ItemType Directory -Force -Path $logDir, $launchDir, $DataDir | Out-Null
# Restrict the token-bearing launcher and log directories before writing secrets
# into them; new files created inside inherit the owner-only ACE.
Set-OwnerOnlyAcl -Path $launchDir
Set-OwnerOnlyAcl -Path $logDir

if (-not $SkipBuild) {
  Write-Host 'Building Tailhub (client SDK + hub)...' -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}

$cliPath = Join-Path $Root 'packages\hub\dist\cli.js'
if (-not (Test-Path $cliPath)) { throw "Hub is not built ($cliPath missing). Run without -SkipBuild." }

# Stop a previous instance if we know its pid
if (Test-Path $pidFile) {
  & (Join-Path $PSScriptRoot 'stop-hub.ps1') -Quiet
}
# Free the port if something else is still bound
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $listeners) {
  try {
    & taskkill.exe /PID $c.OwningProcess /T /F 2>$null | Out-Null
    Write-Host "Freed port $Port (killed pid $($c.OwningProcess))" -ForegroundColor DarkYellow
  } catch { }
}

# Token resolution: param/env -> persisted file -> let the hub generate one
$tokenFile = Join-Path $DataDir 'admin-token.txt'
if (-not $Token -and (Test-Path $tokenFile)) {
  $fromFile = (Get-Content -Path $tokenFile -Raw -ErrorAction SilentlyContinue)
  if ($fromFile) { $Token = $fromFile.Trim() }
  if ($Token) { Write-Host "Loaded admin token from $tokenFile" -ForegroundColor Green }
}
if ($Token -and -not (Test-Path $tokenFile)) {
  [System.IO.File]::WriteAllText($tokenFile, $Token + "`n")
  Write-Host "Saved admin token to $tokenFile for future starts." -ForegroundColor Green
}
# The admin token file is a plaintext secret — mirror the Node side's 0600 with
# an owner-only NTFS ACL (also repairs a file left world-readable by an older run).
Set-OwnerOnlyAcl -Path $tokenFile

$outLog = Join-Path $logDir 'hub.out.log'
$errLog = Join-Path $logDir 'hub.err.log'
foreach ($f in @($outLog, $errLog)) { [System.IO.File]::WriteAllText($f, '') }

$nodeCmd = (Get-Command node -ErrorAction Stop).Source

function Escape-CmdValue {
  param([string]$Value)
  if ($null -eq $Value) { return '' }
  $out = $Value
  $out = $out.Replace('^', '^^')
  $out = $out.Replace('&', '^&')
  $out = $out.Replace('|', '^|')
  $out = $out.Replace('<', '^<')
  $out = $out.Replace('>', '^>')
  $out = $out.Replace('"', '`"')
  return $out
}

function Write-AsciiFile {
  param([string]$Path, [string[]]$Lines)
  $text = ($Lines -join "`r`n") + "`r`n"
  $enc = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $text, $enc)
}

$launcher = Join-Path $launchDir 'run-hub.cmd'
$runLine = '"' + $nodeCmd + '" "' + $cliPath + '" start >> "' + $outLog + '" 2>> "' + $errLog + '"'
$launcherLines = @(
  '@echo off'
  ('set "TAILHUB_PORT=' + (Escape-CmdValue ([string]$Port)) + '"')
  ('set "TAILHUB_HOST=' + (Escape-CmdValue $BindHost) + '"')
  ('set "TAILHUB_DATA_DIR=' + (Escape-CmdValue $DataDir) + '"')
)
if ($Token) { $launcherLines += ('set "TAILHUB_TOKEN=' + (Escape-CmdValue $Token) + '"') }
$launcherLines += ('cd /d "' + $Root + '"')
$launcherLines += $runLine
Write-AsciiFile -Path $launcher -Lines $launcherLines
# Re-assert owner-only on the launcher itself: it embeds the token verbatim, and
# an overwrite preserves a pre-existing file's ACL rather than the dir's.
Set-OwnerOnlyAcl -Path $launcher

# Hidden launcher: WScript.Shell.Run style 0 = no console window.
$hiddenVbs = Join-Path $launchDir 'run-hidden.vbs'
Write-AsciiFile -Path $hiddenVbs -Lines @(
  "' Run a .cmd fully hidden (window style 0)."
  'If WScript.Arguments.Count < 1 Then WScript.Quit 1'
  'CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """", 0, False'
)

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path $wscript)) { $wscript = 'wscript.exe' }
$commandLine = '"' + $wscript + '" //B //Nologo "' + $hiddenVbs + '" "' + $launcher + '"'
$result = ([wmiclass]'Win32_Process').Create($commandLine)
if ($result.ReturnValue -ne 0) {
  throw ('Failed to start hidden hub process. WMI ReturnValue=' + $result.ReturnValue)
}
$launcherPid = [int]$result.ProcessId

# Wait for health
$ok = $false
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 300
  try {
    $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 2
    if ($r.status -eq 'ok') { $ok = $true; break }
  } catch { }
}

$hubPid = $null
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { $hubPid = [int]$conn.OwningProcess } else { $hubPid = $launcherPid }
Write-AsciiFile -Path $pidFile -Lines @(
  ('hub=' + $hubPid)
  ('launcher=' + $launcherPid)
  ('port=' + $Port)
  ('started=' + (Get-Date -Format o))
)

if (-not $ok) {
  Write-Host 'Hub process launched but the health check failed.' -ForegroundColor Red
  if (Test-Path $errLog) { Get-Content $errLog -Tail 30 | Write-Host }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 30 | Write-Host }
  throw ('Hub not reachable on http://127.0.0.1:' + $Port + '/health')
}

Write-Host ''
Write-Host 'Tailhub is running.' -ForegroundColor Green
Write-Host ('  Hub + console: http://127.0.0.1:' + $Port + '  (pid ' + $hubPid + ')')
Write-Host ('  Data dir:      ' + $DataDir)
Write-Host ('  Admin token:   ' + $tokenFile)
Write-Host ('  Logs:          ' + $logDir)
Write-Host '  Stop:          .\scripts\stop-hub.ps1'
Write-Host ''
Write-Host 'Expose over your tailnet with HTTPS (run once, Administrator PowerShell):'
Write-Host '  .\scripts\setup-tailscale-https.ps1'
