# Run from Windows PowerShell, no administrator required if old tasks/processes belong to this user.
# Removes only tasks HomeMCP-Airlock/HomeMCP-Browser/HomeMCP-Computer and verified listeners.
[CmdletBinding(SupportsShouldProcess=$true)]
param([switch]$RemoveLegacyFiles)
$ErrorActionPreference='Stop'
$tasks=@('HomeMCP-Airlock','HomeMCP-Browser','HomeMCP-Computer')
$portExpected=@{
  4111='airlock'; 4112='airlock'; 8931='playwright'; 8932='windows-mcp'
}
Write-Host "Legacy tasks:"
foreach($task in $tasks){
 $t=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
 if(!$t){continue}
 $a=($t.Actions|Select-Object -First 1)
 Write-Host "$task $($t.State): $($a.Execute) $($a.Arguments)"
 if($a.Execute -notmatch 'wscript\.exe$' -or $a.Arguments -notmatch 'C:\\HomeMCP\\start-(airlock|browser|computer)\.vbs'){
   Write-Warning "Skipping unexpected task action: $task"
   continue
 }
 if($PSCmdlet.ShouldProcess($task,'Stop and unregister old scheduled task')){
   Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
   Unregister-ScheduledTask -TaskName $task -Confirm:$false
 }
}
Start-Sleep -Seconds 2
$seen=@{}
foreach($port in $portExpected.Keys){
 $rows=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
 foreach($row in $rows){
  $pidValue=[int]$row.OwningProcess
  if($seen.ContainsKey($pidValue)){continue}
  $seen[$pidValue]=$true
  $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
  if(!$proc){continue}
  $cmd=[string]$proc.CommandLine
  $expected=$portExpected[$port]
  $isOurWorker= switch($expected){
    'airlock' {($cmd -match 'airlock-bot|\\airlock\\|airlock\.yaml') -and ($cmd -match 'C:\\HomeMCP\\airlock\.yaml|airlock-bot\\dist\\index')}
    'playwright' {($cmd -match '@playwright[/\\]mcp|playwright[/\\]cli') -and ($cmd -match '8931|EdgeProfile')}
    'windows-mcp' {($cmd -match 'windows-mcp|windows_mcp') -and ($cmd -match '8932|streamable-http')}
  }
  if(!$isOurWorker) { Write-Warning "Leaving unrelated listener on port $port (PID $pidValue): $cmd";continue }
  Write-Host "Legacy process PID $pidValue port $port : $cmd"
  if($PSCmdlet.ShouldProcess("PID $pidValue",'Stop verified old MCP worker')){Stop-Process -Id $pidValue -Force -ErrorAction Stop}
 }
}
if($RemoveLegacyFiles){
 $folder='C:\HomeMCP'
 if(Test-Path $folder){
  if($PSCmdlet.ShouldProcess($folder,'Rename legacy HomeMCP config/logs to dated backup')){
   $backup="$folder.legacy-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
   Move-Item -LiteralPath $folder -Destination $backup -ErrorAction Stop
   Write-Host "Legacy files preserved at $backup"
  }
 }
}
Write-Host "Legacy cleanup complete. Only verified old MCP processes/tasks were targeted."
