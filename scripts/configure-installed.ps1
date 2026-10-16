param([Parameter(Mandatory=$true)][string]$InstallDir)
$ErrorActionPreference='Stop'
$data=Join-Path $env:LOCALAPPDATA 'HomeMCP'; New-Item -ItemType Directory -Force $data | Out-Null
$config=Join-Path $data 'config.json'
if (!(Test-Path $config)) {
  & (Join-Path $InstallDir 'scripts\install-dev.ps1') -Destination (Join-Path $data 'staging')
  Move-Item (Join-Path $data 'staging\config.json') $config
}
$taskName='HomeMCP-Preview'
$runner=Join-Path $InstallDir 'scripts\start-installed.ps1'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $runner)
$trigger=New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host 'Configured per-user autostart; preview runtime still requires external desktop dependencies.'