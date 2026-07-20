<#
.SYNOPSIS
  Publish the running Tailhub hub through Tailscale Serve HTTPS.

.DESCRIPTION
  Run once from an Administrator PowerShell after .\scripts\start-hub.ps1.
  Adds only the HTTPS:443 handler below; it never resets other Serve
  configuration. After this, every device on your tailnet reaches the hub,
  console, and hosted apps at https://<device>.<tailnet>.ts.net with a real
  certificate — required for PWA installs and WebCrypto on phones.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [int]$Port = $(if ($env:TAILHUB_PORT) { [int]$env:TAILHUB_PORT } else { 4747 })
)

$ErrorActionPreference = 'Stop'
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path $tailscale)) { throw 'Tailscale CLI was not found. Install and sign in to Tailscale first.' }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Open PowerShell as Administrator, then run this script again.'
}

try {
  $status = (& $tailscale status --json | ConvertFrom-Json)
} catch { throw 'Could not read Tailscale status. Confirm the Tailscale service is running and you are signed in.' }

$dnsName = [string]$status.Self.DNSName
if (-not $dnsName) { throw 'MagicDNS did not provide this device a .ts.net hostname. Enable MagicDNS in the tailnet first.' }
$dnsName = $dnsName.TrimEnd('.')
if (-not $dnsName.EndsWith('.ts.net')) { throw "Expected a .ts.net hostname, received: $dnsName" }

try {
  $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 5
  if ($health.status -ne 'ok') { throw 'unexpected response' }
} catch { throw ('Tailhub health check failed on 127.0.0.1:' + $Port + '. Run .\scripts\start-hub.ps1 first.') }

if ($PSCmdlet.ShouldProcess("https://$dnsName", 'Add persistent Tailscale Serve HTTPS handler for Tailhub')) {
  & $tailscale serve --bg --https=443 ('http://127.0.0.1:' + $Port)
  if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve setup failed. The local HTTP hub remains unchanged.' }
}

try {
  $secureHealth = Invoke-RestMethod -Uri "https://$dnsName/health" -TimeoutSec 15
  if ($secureHealth.status -ne 'ok') { throw 'unexpected response' }
} catch { throw "Serve was configured, but HTTPS validation failed at https://$dnsName/health. Check tailnet HTTPS certificates and MagicDNS." }

Write-Host "Tailhub HTTPS is ready: https://$dnsName" -ForegroundColor Green
Write-Host "  Console:      https://$dnsName/"
Write-Host "  Hosted apps:  https://$dnsName/apps/<app>/"
Write-Host 'No unrelated Serve handlers were reset.'
