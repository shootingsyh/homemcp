[CmdletBinding()]
param([switch]$Repair)
$ErrorActionPreference='Stop'
$base=Join-Path $env:LOCALAPPDATA 'HomeMCP'
$bridge=Join-Path $base 'start-cloudflare-bridge.ps1'
$proxy=Join-Path $base 'protected-proxy.mjs'
$cloudcfg=Join-Path $base 'cloudflared\config.yml'
$credentials=Join-Path $base 'cloudflared\credentials.json'
# Never bootstrap a new tunnel from a health probe.
if(!(Test-Path $bridge) -or !(Test-Path $proxy) -or !(Test-Path $cloudcfg) -or !(Test-Path $credentials)){exit 0}
function Healthy {
 $procs=@(Get-CimInstance Win32_Process -ErrorAction Stop)
 $p=@($procs | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -like '*HomeMCP*protected-proxy.mjs*'})
 $t=@($procs | Where-Object {$_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*HomeMCP*cloudflared*config.yml*'})
 if($p.Count -ne 1 -or $t.Count -ne 1){return $false}
 $listener=@(Get-NetTCPConnection -State Listen -LocalPort 59202 -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $p[0].ProcessId})
 return $listener.Count -eq 1
}
if(Healthy){exit 0}
if(!$Repair){exit 2}
# Existing idempotent starter only operates on the HomeMCP-owned Windows bridge.
& $bridge | Out-Null
Start-Sleep -Seconds 3
if(Healthy){exit 0}
exit 3
