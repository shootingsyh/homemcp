param(
 [ValidateSet('Check','Install')][string]$Mode='Check',
 [string]$FeedUrl=$env:HOMEMCP_UPDATE_FEED,
 [string]$TrustedSignerThumbprint=$env:HOMEMCP_UPDATE_SIGNER,
 [switch]$Force
)
$ErrorActionPreference='Stop'
if(!$FeedUrl -or !$FeedUrl.StartsWith('https://')){throw 'HTTPS update feed must be configured'}
if(!$TrustedSignerThumbprint -or $TrustedSignerThumbprint -notmatch '^[0-9A-Fa-f]{40,64}$'){throw 'Pinned Authenticode publisher thumbprint must be configured'}
$root=Join-Path $env:LOCALAPPDATA 'HomeMCP'
$update=Join-Path $root 'updates';New-Item -ItemType Directory -Force $update|Out-Null
$lock=Join-Path $update 'update.lock'
$lockStream=$null
try {
 $lockStream=[IO.File]::Open($lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $stamp=Join-Path $update 'last-check.json'
 if(!$Force -and (Test-Path $stamp)){
  $last=Get-Content $stamp -Raw|ConvertFrom-Json
  if([datetime]::UtcNow -lt ([datetime]$last.checkedAt).AddHours(24)){Write-Host 'Update checked recently';return}
 }
 $manifest=Invoke-RestMethod -Uri $FeedUrl -TimeoutSec 15
 if(!$manifest.version -or !$manifest.url -or !$manifest.sha256){throw 'Invalid release manifest'}
 if(!$manifest.url.StartsWith('https://')){throw 'MSI URL must use HTTPS'}
 if($manifest.sha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'Invalid SHA-256'}
 $current=(Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw|ConvertFrom-Json).version
 if([version]$manifest.version -le [version]$current){Write-Host "Up to date: $current";return}
 if($Mode -eq 'Check'){Write-Host "Update available: $($manifest.version) (installed $current)";return}
 $destination=Join-Path $update ("HomeMCP-"+$manifest.version+".msi")
 $temporary=$destination+'.part'
 if(Test-Path $temporary){Remove-Item $temporary -Force}
 Invoke-WebRequest -Uri $manifest.url -OutFile $temporary -TimeoutSec 300
 $actual=(Get-FileHash $temporary -Algorithm SHA256).Hash
 if($actual -ne $manifest.sha256.ToUpperInvariant()){throw 'Downloaded MSI SHA256 mismatch'}
 $sig=Get-AuthenticodeSignature -FilePath $temporary
 $thumb=([string]$sig.SignerCertificate.Thumbprint).Replace(' ','').ToUpperInvariant()
 if($sig.Status -ne 'Valid' -or $thumb -ne $TrustedSignerThumbprint.ToUpperInvariant()){throw 'Untrusted or unsigned MSI; refusing installation'}
 Move-Item $temporary $destination -Force
 # Installation is delegated to Windows Installer. Only the trusted, fully downloaded MSI is launched.
 # Never kill arbitrary node/python processes and do not silently bypass UAC.
 $log=Join-Path $update ("msi-"+$manifest.version+".log")
 $p=Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i',('"'+$destination+'"'),'/qn','/norestart','/l*v',('"'+$log+'"')) -PassThru -Wait
 if($p.ExitCode -notin @(0,3010)){throw "Windows Installer failed: $($p.ExitCode). Log: $log"}
 Write-Host "Update installed: $($manifest.version); restart required: $($p.ExitCode -eq 3010)"
} finally {
 if($lockStream){$lockStream.Dispose()}
 if($Mode -eq 'Check'){
  @{checkedAt=([datetime]::UtcNow.ToString('o'))}|ConvertTo-Json|Set-Content $stamp -Encoding UTF8
 }
}
