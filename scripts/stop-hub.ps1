<#
.SYNOPSIS
  Stop the background hub started by start-hub.ps1.
#>
param([switch]$Quiet)

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
  if ($line -match '^(hub|launcher)=(\d+)$') {
    $procId = [int]$Matches[2]
    if ($procId -le 0) { continue }
    try {
      $null = Get-Process -Id $procId -ErrorAction Stop
      & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
      if (-not $Quiet) { Write-Host "Stopped $($Matches[1]) (pid $procId)" }
    } catch {
      if (-not $Quiet) { Write-Host "Already gone: pid $procId" }
    }
  }
}

# Also free the hub port if a listener remains
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $listeners) {
  try {
    & taskkill.exe /PID $c.OwningProcess /T /F 2>$null | Out-Null
    if (-not $Quiet) { Write-Host "Freed port $port (pid $($c.OwningProcess))" }
  } catch { }
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
if (-not $Quiet) { Write-Host 'Hub stopped.' }
