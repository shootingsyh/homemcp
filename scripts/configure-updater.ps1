[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^https://')][string]$FeedUrl,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{40,64}$')][string]$SignerThumbprint,
 [switch]$InstallImmediately
)
$ErrorActionPreference='Stop'
$uri=$null
if($FeedUrl -match '["\r\n]' -or ![Uri]::TryCreate($FeedUrl,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo){throw 'Use an HTTPS feed URL without embedded credentials or quotes'}
$root=Join-Path $env:LOCALAPPDATA 'HomeMCP'
New-Item -ItemType Directory -Force $root | Out-Null
$configPath=Join-Path $root 'update-source.json'
$data=@{feedUrl=$FeedUrl;signerThumbprint=$SignerThumbprint;automaticInstall=[bool]$InstallImmediately}
[IO.File]::WriteAllText($configPath,($data | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
$me=([Security.Principal.WindowsIdentity]::GetCurrent()).Name
& icacls.exe $configPath /inheritance:r /grant:r "$($me):(F)" | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot protect updater configuration'}
$scriptPath=Join-Path $PSScriptRoot 'update.ps1'
$mode=if($InstallImmediately){'Install'}else{'Check'}
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Mode {1} -FeedUrl "{2}" -TrustedSignerThumbprint "{3}"' -f $scriptPath,$mode,$FeedUrl,$SignerThumbprint)
$trigger=New-ScheduledTaskTrigger -Daily -At '03:00'
$principal=New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -StartWhenAvailable
Register-ScheduledTask -TaskName 'HomeMCP-Updater' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "HomeMCP updater configured ($mode, daily, when user logged on). No reboot needed."

