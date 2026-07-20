<#
.SYNOPSIS
  Remove the Tailhub at-logon Scheduled Task registered by install-hub-startup.ps1.
#>
$ErrorActionPreference = 'Stop'
$taskName = 'TailhubHub'
try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  Write-Host "Scheduled task '$taskName' removed."
} catch {
  Write-Host "Scheduled task '$taskName' was not registered."
}
