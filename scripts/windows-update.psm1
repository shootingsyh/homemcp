Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Set-UpdateStatus($Job,$Phase,$Detail){
 $json=@{phase=$Phase;detail=$Detail;updatedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json
 [IO.File]::WriteAllText((Join-Path $Job 'status.tmp'),$json,[Text.UTF8Encoding]::new($false))
 Move-Item (Join-Path $Job 'status.tmp') (Join-Path $Job 'status.json') -Force
}
function Get-MsiIdentity([string]$Path){
 $installer=New-Object -ComObject WindowsInstaller.Installer
 $db=$installer.OpenDatabase($Path,0)
 $values=@{}
 try{
  foreach($key in @('ProductCode','UpgradeCode','ProductVersion')){
   $view=$db.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$key'");$view.Execute();$record=$view.Fetch()
   if(!$record){throw "Missing MSI property: $key"};$values[$key]=$record.StringData(1);$view.Close()
  }
  [pscustomobject]$values
 }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($db);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)}
}
function Assert-UpdateHash($Path,$Hash){
 if($Hash -notmatch '^[a-fA-F0-9]{64}$'){throw 'A trusted SHA-256 is required'}
 if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Hash){throw 'Package SHA-256 mismatch'}
}
function Assert-UpdateSigner($Path,$Thumbprint){
 if($Thumbprint -notmatch '^[a-fA-F0-9]{40,64}$'){throw 'A pinned publisher thumbprint is required for automatic remote updates'}
 $signature=Get-AuthenticodeSignature -LiteralPath $Path
 if($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint.Replace(' ','') -ne $Thumbprint.Replace(' ','')){throw 'Package publisher is not trusted'}
}
function Get-RegisteredHomeMcp([switch]$AllowMissing) {
 $installer=New-Object -ComObject WindowsInstaller.Installer
 try{
  $products=@($installer.RelatedProducts('{E9437E1E-90A8-4D3D-9870-6A591E159CE4}'))
  if($AllowMissing -and $products.Count -eq 0){return $null}
  if($products.Count -ne 1){throw 'Exactly one installed HomeMCP MSI is required for rollback'}
  [pscustomobject]@{ProductCode=[string]$products[0];ProductVersion=$installer.ProductInfo($products[0],'VersionString')}
 }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)}
}
function Invoke-UpdateProcess($Exe,[string[]]$Arguments,[int]$Timeout=120){
 $out=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()+'.out')
 $err=$out+'.err'
 try{
  $quoted=@($Arguments|ForEach-Object {if($_ -match '["\r\n]'){throw 'Invalid process argument'};'"'+$_+'"'})
  $start=@{FilePath=$Exe;PassThru=$true;RedirectStandardOutput=$out;RedirectStandardError=$err;WindowStyle="Hidden"}
  if($quoted.Count -gt 0){$start.ArgumentList=$quoted}
  $p=Start-Process @start
  $null=$p.Handle
  if(!$p.WaitForExit($Timeout*1000)){& "$env:SystemRoot\System32\taskkill.exe" /PID $p.Id /T /F|Out-Null;throw "Process timeout: $Exe"}
  $p.WaitForExit()
  if($p.ExitCode -ne 0){throw "Process failed ($($p.ExitCode)): $Exe $(Get-Content $err -Raw)"}
  Get-Content $out -Raw
 }finally{Remove-Item $out,$err -Force -ErrorAction SilentlyContinue}
}
function Invoke-MsiUpdate($Package,$Log,$Action='Install'){
 $verb=if($Action -eq 'Remove'){'/x'}elseif($Action -eq 'Extract'){'/a'}else{'/i'}
 $args=@($verb,('"'+$Package+'"'),'/qn','/norestart','/l*v',('"'+$Log+'"'))
 $p=Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $args -PassThru
 $null=$p.Handle
 if(!$p.WaitForExit(600000)){throw 'INSTALLER_BUSY: installer is still running; recovery must not compete with it'}
 $p.WaitForExit();if($p.ExitCode -notin @(0,3010)){throw "Windows Installer failed: $($p.ExitCode). See $Log"}
 if($p.ExitCode -eq 3010){throw 'REBOOT_REQUIRED: installer requires reboot'}
}
function Stop-HomeMcpForUpdate {
 $pipe=New-Object IO.Pipes.NamedPipeClientStream('.','HomeMCP-Manager',[IO.Pipes.PipeDirection]::InOut)
 try{
  $pipe.Connect(5000);$pipe.ReadMode=[IO.Pipes.PipeTransmissionMode]::Byte
  $writer=New-Object IO.StreamWriter($pipe);$writer.AutoFlush=$true;$writer.WriteLine('prepare-update')
  $reader=New-Object IO.StreamReader($pipe)
  $read=$reader.ReadLineAsync();if(!$read.Wait(15000)){throw 'Manager shutdown acknowledgement timed out'}
  if($read.Result -ne 'UPDATE_READY'){throw 'Manager does not support safe update shutdown; install the updater bootstrap version first'}
 }finally{$pipe.Dispose()}
 for($i=0;$i -lt 10;$i++){
  $manager=@(Get-Process -Name HomeMCP.Manager -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq (Join-Path $env:LOCALAPPDATA 'HomeMCP\app\runtime\HomeMCP.Manager.exe')})
  if($manager.Count -eq 0){
   $server=[regex]::Escape((Join-Path $env:LOCALAPPDATA 'HomeMCP\app\src\server.mjs'))
   $hosts=@(Get-CimInstance Win32_Process -Filter "name='node.exe'"|Where-Object {$_.CommandLine -match $server})
   if($hosts.Count -gt 0){throw 'An installed HomeMCP Host is still running; refusing cutover'}
   return
  };Start-Sleep -Seconds 1
 }
 throw 'Manager has not exited; refusing cutover'
}
function Test-HomeMcpLive($Root,[int]$Attempts=30){
 $configPath=Join-Path $Root 'config.json'
 for($i=0;$i -lt $Attempts;$i++){
  try{
   $config=Get-Content $configPath -Raw|ConvertFrom-Json
   $health=Invoke-RestMethod -Uri ("http://127.0.0.1:"+$config.port+'/health') -TimeoutSec 2
   if($health.ok -eq $true -and $health.workers.browser.status -in @('ready','stopped') -and $health.workers.desktop.status -in @('ready','stopped')){return $true}
  }catch{}
  Start-Sleep -Seconds 1
 }
 return $false
}
function Test-HomeMcpCandidate($Candidate,$Job){
 $node=Join-Path $Candidate 'runtime\node.exe'
 foreach($relative in @('package.json','src\server.mjs','runtime\HomeMCP.Manager.exe','runtime\homemcp-frp.dll','workers\playwright\cli.mjs','workers\windows-mcp\python.exe')){
  if(!(Test-Path -LiteralPath (Join-Path $Candidate $relative) -PathType Leaf)){throw "Candidate component missing: $relative"}
 }
 $null=Invoke-UpdateProcess $node @('--version')
 $null=Invoke-UpdateProcess $node @('--check',(Join-Path $Candidate 'src\server.mjs'))
 $null=Invoke-UpdateProcess $node @((Join-Path $Candidate 'workers\playwright\cli.mjs'),'--help')
 $null=Invoke-UpdateProcess (Join-Path $Candidate 'workers\windows-mcp\python.exe') @('-m','windows_mcp','--help')
 $names=@('HOMEMCP_UI_SMOKE','HOMEMCP_UI_SMOKE_PAGE','HOMEMCP_UI_SMOKE_MARKER')
 $before=@{};foreach($name in $names){$before[$name]=[Environment]::GetEnvironmentVariable($name)}
 try{
  $env:HOMEMCP_UI_SMOKE='1'
  foreach($page in @('wizard','dashboard')){
   $env:HOMEMCP_UI_SMOKE_PAGE=$page;$env:HOMEMCP_UI_SMOKE_MARKER=Join-Path $Job ($page+'.ready')
   Remove-Item $env:HOMEMCP_UI_SMOKE_MARKER -Force -ErrorAction SilentlyContinue
   $null=Invoke-UpdateProcess (Join-Path $Candidate 'runtime\HomeMCP.Manager.exe') @() 30
   if(!(Test-Path $env:HOMEMCP_UI_SMOKE_MARKER)){throw "Candidate UI failed: $page"}
  }
 }finally{foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$before[$name])}}
 $probe=Join-Path $PSScriptRoot 'windows-update-probe.ps1'
 $null=Invoke-UpdateProcess (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoProfile','-ExecutionPolicy','Bypass','-File',$probe,'-Candidate',$Candidate,'-Job',$Job) 180
}
function Expand-HomeMcpMsi($Package,$Job){
 $target=Join-Path $Job 'extracted'
 New-Item -ItemType Directory -Path $target -Force|Out-Null
 $p=Start-Process msiexec.exe -ArgumentList @('/a',('"'+$Package+'"'),'/qn','/norestart',('TARGETDIR="'+$target+'"'),'/l*v',('"'+(Join-Path $Job 'extract.log')+'"')) -PassThru
 $null=$p.Handle
 if(!$p.WaitForExit(300000)){throw 'INSTALLER_BUSY: MSI extraction is still running'};$p.WaitForExit();if($p.ExitCode -ne 0){throw 'Candidate MSI extraction failed'}
 $managers=@(Get-ChildItem $target -Filter HomeMCP.Manager.exe -File -Recurse)
 if($managers.Count -ne 1){throw 'Ambiguous HomeMCP MSI payload'}
 Split-Path (Split-Path $managers[0].FullName -Parent) -Parent
}
function Invoke-HomeMcpTransaction($Job,$Root,$CandidateMsi,$RollbackMsi,$ExpectedVersion){
 # The orchestrator is intentionally separate from package discovery and trust checks.
 # No stop/install action occurs before all candidate and rollback preflight checks pass.
 $switched=$false;$stopped=$false
 try{
  Set-UpdateStatus $Job 'preflight' 'Verifying candidate and rollback installation identities.'
  $installed=Get-RegisteredHomeMcp
  $candidate=Get-MsiIdentity $CandidateMsi;$rollback=Get-MsiIdentity $RollbackMsi
  if($candidate.UpgradeCode -ne '{E9437E1E-90A8-4D3D-9870-6A591E159CE4}' -or $rollback.ProductCode -ne $installed.ProductCode){throw 'MSI identity does not match HomeMCP or installed rollback product'}
  if($candidate.ProductVersion -ne $ExpectedVersion -or [version]$candidate.ProductVersion -le [version]$installed.ProductVersion){throw 'Candidate MSI version is not a newer matching release'}
  $candidateRoot=Expand-HomeMcpMsi $CandidateMsi $Job
  if((Get-Content (Join-Path $candidateRoot 'package.json') -Raw|ConvertFrom-Json).version -ne $ExpectedVersion){throw 'Payload and MSI versions disagree'}
  Test-HomeMcpCandidate $candidateRoot $Job
  $rollbackJob=Join-Path $Job 'rollback-preflight';New-Item -ItemType Directory $rollbackJob|Out-Null
  $rollbackRoot=Expand-HomeMcpMsi $RollbackMsi $rollbackJob
  Test-HomeMcpCandidate $rollbackRoot $rollbackJob
  Set-UpdateStatus $Job 'switching' 'Preflight passed. Stopping HomeMCP and saving state.'
  Stop-HomeMcpForUpdate;$stopped=$true
  $snapshot=Join-Path $Job 'state-before';New-Item -ItemType Directory -Path $snapshot|Out-Null
  foreach($file in @('config.json','network-setup.json','setup-complete.marker')){if(Test-Path (Join-Path $Root $file)){Copy-Item (Join-Path $Root $file) $snapshot -Force}}
  if(Test-Path (Join-Path $Root 'data')){Copy-Item (Join-Path $Root 'data') $snapshot -Recurse -Force}
  $switched=$true
  Invoke-MsiUpdate $CandidateMsi (Join-Path $Job 'install.log')
  if((Get-Content (Join-Path $Root 'app\package.json') -Raw|ConvertFrom-Json).version -ne $ExpectedVersion){throw 'Installed payload version mismatch'}
  Start-Process (Join-Path $Root 'app\runtime\HomeMCP.Manager.exe')|Out-Null
  Set-UpdateStatus $Job 'checking' 'Checking Host and browser/desktop workers after cutover.'
  if(!(Test-HomeMcpLive $Root)){throw 'New HomeMCP did not pass live health checks'}
  Copy-Item $CandidateMsi (Join-Path $Root 'updates\last-good.msi') -Force
  Set-UpdateStatus $Job 'complete' "Update $ExpectedVersion passed live health checks."
 }catch{
  $errorText=$_.Exception.Message
  if($errorText -match 'INSTALLER_BUSY|REBOOT_REQUIRED'){[IO.File]::WriteAllText((Join-Path $Root 'updates\recovery-required.lock'),$errorText);Set-UpdateStatus $Job 'recovery_required' $errorText;throw $errorText}
  if($switched){
   try{
    Set-UpdateStatus $Job 'rolling_back' $errorText
    # A newly started Manager may support the shutdown protocol. No broad process kills.
    $managers=@(Get-Process -Name HomeMCP.Manager -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq (Join-Path $Root 'app\runtime\HomeMCP.Manager.exe')})
    if($managers.Count -gt 0){Stop-HomeMcpForUpdate}
    $current=Get-RegisteredHomeMcp -AllowMissing
    if($current -and $current.ProductCode -ne $installed.ProductCode){Invoke-MsiUpdate $current.ProductCode (Join-Path $Job 'remove-failed.log') 'Remove'}
    Invoke-MsiUpdate $RollbackMsi (Join-Path $Job 'rollback.log')
    foreach($file in @('config.json','network-setup.json','setup-complete.marker')){if(Test-Path (Join-Path $snapshot $file)){Copy-Item (Join-Path $snapshot $file) (Join-Path $Root $file) -Force}}
    if(Test-Path (Join-Path $snapshot 'data')){if(Test-Path (Join-Path $Root 'data')){Move-Item (Join-Path $Root 'data') (Join-Path $Job 'failed-data')};Copy-Item (Join-Path $snapshot 'data') $Root -Recurse}
    Start-Process (Join-Path $Root 'app\runtime\HomeMCP.Manager.exe')|Out-Null
    if(!(Test-HomeMcpLive $Root)){throw 'Previous version did not become healthy after rollback'}
    Set-UpdateStatus $Job 'rolled_back' $errorText
   }catch{Set-UpdateStatus $Job 'recovery_required' ($errorText+'; rollback: '+$_.Exception.Message)}
  }else{
   if($stopped){Start-Process (Join-Path $Root 'app\runtime\HomeMCP.Manager.exe')|Out-Null}
   Set-UpdateStatus $Job 'failed' $errorText
  }
  throw $errorText
 }
}
Export-ModuleMember -Function *
