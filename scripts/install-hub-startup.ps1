<#
.SYNOPSIS
  Register a current-user Scheduled Task to start the Tailhub hub at logon.

.DESCRIPTION
  Runs scripts\start-hub.ps1 -SkipBuild hidden at logon so the hub comes up
  without a console window. After code upgrades, run start-hub.ps1 once with a
  full build so dist/ stays current.
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-hub.ps1'
if (-not (Test-Path $startScript)) { throw "Missing $startScript" }

$taskName = 'TailhubHub'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -SkipBuild"

$action = New-ScheduledTaskAction -Execute $ps -Argument $taskArgs -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Start the Tailhub artifact sync hub at logon' `
  -Force | Out-Null

Write-Host "Scheduled task '$taskName' registered for user $env:USERNAME (at logon)." -ForegroundColor Green
Write-Host "  Start now:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "  Remove:     .\scripts\uninstall-hub-startup.ps1"
Write-Host "  After code changes, run: .\scripts\start-hub.ps1  (full build)"
