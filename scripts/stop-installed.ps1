param([switch]$RemoveTask)
$task='HomeMCP-Preview'
$found=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($found) {
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  if($RemoveTask){ Unregister-ScheduledTask -TaskName $task -Confirm:$false }
}
# Safety: do not kill node.exe by name/port. This preview cannot yet reliably stop
# the detached worker process tree. Job Object supervisor required before release.