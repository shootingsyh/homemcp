# Optional Cloudflare provisioning; does not start or expose any tunnel.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_-]{1,128}$')][string]$TunnelName,
 [Parameter(Mandatory)][ValidatePattern('^[a-z0-9.-]+$')][string]$Hostname,
 [switch]$ReuseExisting,
 [switch]$InstallCloudflared
)
$ErrorActionPreference='Stop'
if($Hostname -notmatch '\.' -or $Hostname -match '\.\.' -or $Hostname.StartsWith('.') -or $Hostname.EndsWith('.')){throw 'Invalid hostname'}
if($InstallCloudflared){
 if(!(Get-Command winget.exe -ErrorAction SilentlyContinue)){throw 'winget unavailable: install Cloudflare cloudflared manually'}
 winget install --id Cloudflare.cloudflared --exact --accept-source-agreements --accept-package-agreements
 if($LASTEXITCODE -ne 0){throw 'cloudflared installation failed'}
}
$cloudflared=(Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
if(!$cloudflared){throw 'cloudflared.exe unavailable: reopen PowerShell after installing it'}
$configPath=Join-Path $env:LOCALAPPDATA 'HomeMCP\config.json'
if(!(Test-Path $configPath)){throw 'Start installed HomeMCP once before configuring tunnel'}
$config=Get-Content $configPath -Raw|ConvertFrom-Json
if($config.egress.enabled){throw 'Existing remote egress detected; refusing to override'}
$cloudflareDir=Join-Path $env:USERPROFILE '.cloudflared'
if(!(Test-Path (Join-Path $cloudflareDir 'cert.pem'))){
 Write-Host 'Cloudflare sign-in will open. You must own a DNS zone for the requested hostname.'
 & $cloudflared tunnel login
 if($LASTEXITCODE -ne 0){throw 'Cloudflare login failed'}
}
if(!$ReuseExisting){
 & $cloudflared tunnel create $TunnelName
 if($LASTEXITCODE -ne 0){throw 'Tunnel creation failed'}
}
$tunnelsRaw=& $cloudflared tunnel list --output json
if($LASTEXITCODE -ne 0){throw 'Tunnel discovery failed'}
$matching=@($tunnelsRaw|ConvertFrom-Json|Where-Object {$_.name -eq $TunnelName})
if($matching.Count -ne 1){throw 'Expected exactly one matching tunnel; check the name'}
$id=[string]$matching[0].id
$cred=Join-Path $cloudflareDir ($id+'.json')
if(!(Test-Path $cred)){throw 'Tunnel credentials unavailable locally: use the original credentials or create a new tunnel'}
& $cloudflared tunnel route dns $TunnelName $Hostname
if($LASTEXITCODE -ne 0){throw 'DNS route failed: verify Cloudflare DNS zone ownership'}
$egressDir=Join-Path $env:LOCALAPPDATA 'HomeMCP\egress'
New-Item -ItemType Directory -Force $egressDir|Out-Null
$output=Join-Path $egressDir 'cloudflared.json'
$ingress=@{tunnel=$id;'credentials-file'=$cred;ingress=@(
 @{hostname=$Hostname;service="http://127.0.0.1:$($config.port)"},
 @{service='http_status:404'}
)}
[IO.File]::WriteAllText($output,($ingress|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
& $cloudflared tunnel --config $output ingress validate
if($LASTEXITCODE -ne 0){throw 'Tunnel ingress validation failed'}
Write-Host "Configured DNS and tunnel: https://$Hostname"
Write-Warning 'Tunnel is NOT started and HomeMCP stays local-only until remote authentication is verified.'
Write-Host "Configuration: $output"
