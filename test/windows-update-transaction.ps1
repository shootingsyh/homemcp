$ErrorActionPreference='Stop'
$modulePath=Join-Path $PSScriptRoot '..\scripts\windows-update.psm1'
function Assert($Value,$Message){if(!$Value){throw $Message}}
foreach($scenario in @('preflight-fails','success','bad-health','rollback-fails','installer-busy','wrong-rollback')){
 $module=Import-Module $modulePath -Force -PassThru
 $sandbox=Join-Path $env:TEMP ('homemcp-update-test-'+[guid]::NewGuid());New-Item -ItemType Directory $sandbox|Out-Null
 try{
  & $module {
   param($sandbox,$scenario)
   $script:scenario=$scenario;$script:trace=New-Object 'System.Collections.Generic.List[string]';$script:liveCalls=0
   $root=Join-Path $sandbox 'root';$job=Join-Path $sandbox 'job';New-Item -ItemType Directory $root,$job,(Join-Path $root 'updates')|Out-Null
   $candidate=Join-Path $sandbox 'new.msi';$rollback=Join-Path $sandbox 'old.msi';Set-Content $candidate 'candidate';Set-Content $rollback 'rollback'
   Set-Content (Join-Path $root 'config.json') '{"old":true}'
   function Get-RegisteredHomeMcp([switch]$AllowMissing){[pscustomobject]@{ProductCode=if($script:trace.Contains('install')){'NEW'}else{'OLD'};ProductVersion='1.0.0'}}
   function Get-MsiIdentity($Path){[pscustomobject]@{UpgradeCode='{E9437E1E-90A8-4D3D-9870-6A591E159CE4}';ProductCode=if($Path -like '*new*'){'NEW'}elseif($script:scenario -eq 'wrong-rollback'){'OTHER'}else{'OLD'};ProductVersion=if($Path -like '*new*'){'1.1.0'}else{'1.0.0'}}}
   function Expand-HomeMcpMsi($Package,$Job){$script:trace.Add('expand');$dir=Join-Path $Job 'candidate';New-Item -ItemType Directory $dir|Out-Null;Set-Content (Join-Path $dir 'package.json') '{"version":"1.1.0"}';return $dir}
   function Test-HomeMcpCandidate($Candidate,$Job){$script:trace.Add('preflight');if($script:scenario -eq 'preflight-fails'){throw 'bad candidate'}}
   function Stop-HomeMcpForUpdate{$script:trace.Add('stop')}
   function Invoke-MsiUpdate($Package,$Log,$Action='Install'){
    if($Action -eq 'Remove'){$script:trace.Add('remove');return}
    if($Package -like '*new*'){
     $script:trace.Add('install');if($script:scenario -eq 'installer-busy'){throw 'INSTALLER_BUSY: still running'}
     New-Item -ItemType Directory (Join-Path $root 'app') -Force|Out-Null;Set-Content (Join-Path $root 'app\package.json') '{"version":"1.1.0"}'
     Set-Content (Join-Path $root 'config.json') '{"new":true}'
    }else{$script:trace.Add('rollback');if($script:scenario -eq 'rollback-fails'){throw 'disk error'}}
   }
   function Start-Process{$script:trace.Add('start')}
   function Get-Process {return @()}
   function Test-HomeMcpLive($Root){$script:liveCalls++;return ($script:scenario -eq 'success' -or $script:liveCalls -gt 1)}
   try{Invoke-HomeMcpTransaction $job $root $candidate $rollback '1.1.0'}catch{}
   $phase=(Get-Content (Join-Path $job 'status.json') -Raw|ConvertFrom-Json).phase
   [pscustomobject]@{scenario=$scenario;phase=$phase;trace=@($script:trace.ToArray());config=(Get-Content (Join-Path $root 'config.json') -Raw)}
  } $sandbox $scenario | ForEach-Object {
   $result=$_
   switch($scenario){
    'preflight-fails'{Assert ($result.phase -eq 'failed') 'preflight failure status';Assert ('stop' -notin $result.trace) 'preflight stopped old version'}
    'wrong-rollback'{Assert ($result.phase -eq 'failed') 'wrong rollback status';Assert ('stop' -notin $result.trace) 'wrong rollback stopped old version'}
    'success'{Assert ($result.phase -eq 'complete') 'success not complete';Assert ('rollback' -notin $result.trace) 'successful install rolled back';Assert ([array]::IndexOf($result.trace,'preflight') -lt [array]::IndexOf($result.trace,'stop')) 'stop preceded preflight'}
    'bad-health'{Assert ($result.phase -eq 'rolled_back') 'bad health did not rollback';Assert ($result.config -match 'old') 'rollback did not restore config'}
    'rollback-fails'{Assert ($result.phase -eq 'recovery_required') 'rollback failure falsely succeeded'}
    'installer-busy'{Assert ($result.phase -eq 'recovery_required') 'busy installer not flagged';Assert ('rollback' -notin $result.trace) 'raced a running installer'}
   }
   Write-Output ('PASS: '+$scenario+' -> '+$result.phase)
  }
 }finally{Remove-Module $module -Force;Remove-Item $sandbox -Recurse -Force}
}
# Verify a real staged executable can be invoked without changing the installed app.
$module=Import-Module $modulePath -Force -PassThru
try{
 $file=Join-Path $env:TEMP ([guid]::NewGuid().ToString()+'.msi');Set-Content $file 'trusted fixture'
 Assert-UpdateHash $file (Get-FileHash $file -Algorithm SHA256).Hash
 $rejected=$false;try{Assert-UpdateHash $file ('0'*64)}catch{$rejected=$true};Assert $rejected 'hash mismatch accepted'
 $rejected=$false;try{Assert-UpdateSigner $file 'invalid'}catch{$rejected=$true};Assert $rejected 'invalid signer accepted'
 Write-Output 'PASS: hash and signer rejection'
}finally{Remove-Item $file -Force;Remove-Module $module -Force}
