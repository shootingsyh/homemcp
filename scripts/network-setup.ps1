# HomeMCP first-run network setup. No administrator privileges required.
# Tunnel setup is optional; this wizard never turns on public access.
[CmdletBinding()]
param([switch]$Force)
$ErrorActionPreference='Stop'
$stateDir=Join-Path $env:LOCALAPPDATA 'HomeMCP'
New-Item -ItemType Directory -Force $stateDir|Out-Null
$statePath=Join-Path $stateDir 'network-setup.json'
if((Test-Path $statePath) -and !$Force){Write-Host 'HomeMCP network setup already saved. Use -Force to rerun.';return}
$choices=New-Object System.Collections.Generic.List[object]
function Add-Choice([string]$source,[string]$tunnel,[string]$hostName,[string]$detail){
 $choices.Add([pscustomobject]@{source=$source;tunnel=$tunnel;hostname=$hostName;detail=$detail})
}
function Add-FromConfig([string]$source,[string]$content){
 $tunnelName=''
 if($content -match '(?m)^\s*tunnel:\s*["'']?([a-zA-Z0-9_-]+)'){$tunnelName=$Matches[1]}
 $hostnames=[regex]::Matches($content,'(?m)^\s*-\s*hostname:\s*["'']?([a-z0-9.-]+)')
 foreach($m in $hostnames){ Add-Choice $source $tunnelName $m.Groups[1].Value 'configured ingress hostname (may be in use)' }
}
# Native Windows discovery: locally configured ingress only, not all account-owned DNS zones.
$nativeCloudflared=Get-Command cloudflared.exe -ErrorAction SilentlyContinue
$nativeFolder=Join-Path $env:USERPROFILE '.cloudflared'
if(Test-Path $nativeFolder){
 Get-ChildItem $nativeFolder -File -Include '*.yml','*.yaml' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
  try { Add-FromConfig 'windows' (Get-Content $_.FullName -Raw) } catch { }
 }
}
# WSL discovery, read-only. Do not install WSL, read credential JSON, or change running tunnels.
$wsl=Get-Command wsl.exe -ErrorAction SilentlyContinue
if($wsl){
 try {
  $distroLines=@(& wsl.exe --list --quiet 2>$null)
  foreach($entry in $distroLines){
   $distro=($entry -replace '\0','').Trim()
   if(!$distro -or $distro -notmatch '^[\w.-]+$'){continue}
   $text=@(& wsl.exe -d $distro -- sh -lc 'for f in "$HOME"/.cloudflared/config.yml "$HOME"/.cloudflared/config.yaml; do if [ -r "$f" ]; then cat "$f"; fi; done' 2>$null) -join "\n"
   if($text){Add-FromConfig "wsl:$distro" $text}
  }
 }catch{Write-Warning "WSL detection skipped: $($_.Exception.Message)"}
}
Write-Host ''
Write-Host 'HomeMCP first-run network setup'
Write-Host '  [0] Local only (no account or domain required)'
$i=0
foreach($item in $choices){
 $i++
 Write-Host "  [$i] Existing $($item.source) tunnel $($item.tunnel): $($item.hostname)"
}
$manual=$i+1
$cloudflareNew=$i+2
$other=$i+3
Write-Host "  [$manual] Enter existing Cloudflare hostname manually"
Write-Host "  [$cloudflareNew] Configure Cloudflare (installation/login guide)"
Write-Host "  [$other] Other tunnel / reverse proxy: supply URL manually"
Write-Host ''
$selection=Read-Host "Choose 0-$other (Enter for 0)"
if(!$selection){$selection='0'}
if($selection -notmatch '^[0-9]+$' -or [int]$selection -gt $other){throw 'Invalid selection'}
$mode='local';$hostname='';$url='';$selectedTunnel='';$source=''
if([int]$selection -ge 1 -and [int]$selection -le $choices.Count){
 $item=$choices[[int]$selection-1]
 $mode='existing';$hostname=$item.hostname;$selectedTunnel=$item.tunnel;$source=$item.source
 Write-Warning "The hostname may already serve another app. Do not overwrite its DNS or ingress without checking first."
}elseif([int]$selection -eq $manual -or [int]$selection -eq $other){
 $mode=if([int]$selection -eq $other){'external'}else{'cloudflare-manual'}
 $url=Read-Host 'Enter HTTPS URL (e.g., https://mcp.example.com)'
 $parsed=$null
 if(![Uri]::TryCreate($url,[UriKind]::Absolute,[ref]$parsed) -or $parsed.Scheme -ne 'https' -or !$parsed.Host){throw 'An HTTPS URL is required'}
 $hostname=$parsed.Host
}elseif([int]$selection -eq $cloudflareNew){
 $mode='cloudflare-guide'
 Write-Host '1. Create an account at https://dash.cloudflare.com/sign-up'
 Write-Host '2. Add your domain in Cloudflare DNS (or register one with any registrar).'
 Write-Host '3. Install cloudflared: winget install --id Cloudflare.cloudflared --exact'
 Write-Host '4. Download and run scripts/setup-cloudflare.ps1 from the HomeMCP package.'
 Write-Host '5. Rerun this wizard with -Force to select the configured hostname.'
}
$record=[ordered]@{mode=$mode;hostname=$hostname;url=$url;tunnel=$selectedTunnel;source=$source;configuredAt=(Get-Date).ToUniversalTime().ToString('o');remoteEnabled=$false}
$temporary="$statePath.tmp.$PID"
[IO.File]::WriteAllText($temporary,($record|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Move-Item $temporary $statePath -Force
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $statePath /inheritance:r /grant:r "$($identity):(F)" | Out-Null
Write-Host "Saved preferences to $statePath"
Write-Host 'Remote access remains OFF. HomeMCP will require auth and approval validation before enabling a tunnel.'
