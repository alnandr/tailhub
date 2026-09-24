<#
.SYNOPSIS
  Stop the background hub started by start-hub.ps1.
#>
param([switch]$Quiet)

# A recorded pid can be reused by an unrelated process once the hub exits, and
# anything may hold the port. Only kill processes whose command line shows
# they are this hub (node running dist\cli.js) or its hidden launcher.
function Test-HubProcess {
  param([int]$ProcessId, [string[]]$Markers)
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $proc -or -not $proc.CommandLine) { return $false }
  foreach ($marker in $Markers) {
    if ($proc.CommandLine -like "*$marker*") { return $true }
  }
  return $false
}
$hubMarkers = @('packages\hub\dist\cli.js')
$launcherMarkers = @('run-hidden.vbs', 'run-hub.cmd')

$pidFile = Join-Path $PSScriptRoot '.hub-pid'
if (-not (Test-Path $pidFile)) {
  if (-not $Quiet) { Write-Host 'No hub pid file - nothing to stop.' }
  exit 0
}

$port = 4747
foreach ($line in (Get-Content $pidFile)) {
  if ($line -match '^port=(\d+)$') { $port = [int]$Matches[1] }
}
foreach ($line in (Get-Content $pidFile)) {
  if ($line -notmatch '^(hub|launcher)=(\d+)$') { continue }
  $role = $Matches[1]
  $procId = [int]$Matches[2]
  if ($procId -le 0) { continue }
  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
    if (-not $Quiet) { Write-Host "Already gone: $role pid $procId" }
    continue
  }
  $markers = if ($role -eq 'hub') { $hubMarkers } else { $launcherMarkers }
  if (-not (Test-HubProcess -ProcessId $procId -Markers $markers)) {
    if (-not $Quiet) { Write-Host "Pid $procId is no longer the hub $role - leaving it alone." }
    continue
  }
  & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
  if (-not $Quiet) { Write-Host "Stopped $role (pid $procId)" }
}

# Also free the hub port if a hub listener remains (e.g. a stale pid file).
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $listeners) {
  $owner = [int]$c.OwningProcess
  if (Test-HubProcess -ProcessId $owner -Markers $hubMarkers) {
    & taskkill.exe /PID $owner /T /F 2>$null | Out-Null
    if (-not $Quiet) { Write-Host "Freed port $port (pid $owner)" }
  } elseif (-not $Quiet) {
    Write-Host "Port $port is held by pid $owner, which is not this hub - leaving it alone."
  }
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
if (-not $Quiet) { Write-Host 'Hub stopped.' }
