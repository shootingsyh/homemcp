param(
 [ValidateSet('Check','Install')][string]$Mode='Check',
 [string]$FeedUrl=$env:HOMEMCP_UPDATE_FEED,
 [string]$TrustedSignerThumbprint=$env:HOMEMCP_UPDATE_SIGNER,
 [string]$LocalPackage,
 [string]$Sha256,
 [string]$RollbackPackage,
 [string]$RollbackSha256,
 [string]$JobDirectory,
 [switch]$Force
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'windows-update.psm1') -Force
$root=Join-Path $env:LOCALAPPDATA 'HomeMCP'
$updates=Join-Path $root 'updates';New-Item -ItemType Directory -Force $updates|Out-Null
function Get-HttpsResource($Url,$Destination){
 for($i=0;$i -le 5;$i++){
  $uri=[uri]$Url
  if($uri.Scheme -ne 'https' -or $uri.UserInfo){throw 'HTTPS without embedded credentials is required'}
  $request=[Net.HttpWebRequest]::Create($uri);$request.AllowAutoRedirect=$false;$request.Timeout=30000
  try{$response=$request.GetResponse()}catch{throw 'HTTPS download failed'}
  try{
   $code=[int]$response.StatusCode
   if($code -in @(301,302,303,307,308)){$Url=([uri]::new($uri,$response.Headers['Location'])).AbsoluteUri;continue}
   if($code -ne 200){throw 'Download did not return HTTP 200'}
   if($response.ContentLength -gt 2147483648){throw 'Download too large'}
   $input=$response.GetResponseStream();$output=[IO.File]::Open($Destination,'CreateNew')
   try{$buffer=New-Object byte[] 65536;$total=0;while(($n=$input.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$n;if($total -gt 2147483648){throw 'Download too large'};$output.Write($buffer,0,$n)}}finally{$input.Dispose();$output.Dispose()}
   return
  }finally{$response.Dispose()}
 }
 throw 'Too many HTTPS redirects'
}
if(!$JobDirectory){
 $saved=Join-Path $root 'update-source.json'
 if(Test-Path $saved){$settings=Get-Content $saved -Raw|ConvertFrom-Json;if(!$FeedUrl){$FeedUrl=$settings.feedUrl};if(!$TrustedSignerThumbprint){$TrustedSignerThumbprint=$settings.signerThumbprint}}
 if(!$LocalPackage -and !$FeedUrl){throw 'Choose a local MSI or configure an HTTPS update feed'}
 if(!$LocalPackage -and ([uri]$FeedUrl).Scheme -ne 'https'){throw 'HTTPS update feed required'}
 if($Mode -eq 'Check'){
  if($LocalPackage){Get-MsiIdentity ([IO.Path]::GetFullPath($LocalPackage))|ConvertTo-Json;return}
  $temp=Join-Path $updates ([guid]::NewGuid().ToString()+'.json')
  try{Get-HttpsResource $FeedUrl $temp;$manifest=Get-Content $temp -Raw|ConvertFrom-Json
   if($manifest.version -notmatch '^\d+\.\d+\.\d+$' -or $manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or ([uri]$manifest.url).Scheme -ne 'https'){throw 'Invalid update manifest'}
   $current=Get-RegisteredHomeMcp
   if([version]$manifest.version -le [version]$current.ProductVersion){Write-Output ('Up to date: '+$current.ProductVersion)}else{Write-Output ('Update available: '+$manifest.version)}
  }finally{Remove-Item $temp -ErrorAction SilentlyContinue};return
 }
 $job=Join-Path $updates ('job-'+[guid]::NewGuid().ToString());New-Item -ItemType Directory $job|Out-Null
 $me=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 & icacls.exe $job /inheritance:r /grant:r "$($me):(OI)(CI)(F)"|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect updater job directory'}
 Copy-Item $PSCommandPath (Join-Path $job 'update.ps1')
 Copy-Item (Join-Path $PSScriptRoot 'windows-update.psm1') $job
 Copy-Item (Join-Path $PSScriptRoot 'windows-update-probe.ps1') $job
 Copy-Item (Join-Path $PSScriptRoot 'windows-update-workers.mjs') $job
 $request=@{localPackage=$LocalPackage;sha256=$Sha256;rollbackPackage=$RollbackPackage;rollbackSha256=$RollbackSha256;feedUrl=$FeedUrl;signer=$TrustedSignerThumbprint}
 [IO.File]::WriteAllText((Join-Path $job 'request.json'),($request|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Set-UpdateStatus $job 'starting' 'Starting independent Windows updater.'
 [IO.File]::WriteAllText((Join-Path $updates 'latest.json'),(@{job=$job}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 Start-Process $ps -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $job 'update.ps1')+'"'),'-JobDirectory',('"'+$job+'"'))|Out-Null
 Write-Output $job;return
}
$lock=$null
try{
 $lock=[IO.File]::Open((Join-Path $updates 'update.lock'),'OpenOrCreate','ReadWrite','None')
 if(Test-Path (Join-Path $updates 'recovery-required.lock')){throw 'A previous update needs manual recovery. Check logs before retrying.'}
 $r=Get-Content (Join-Path $JobDirectory 'request.json') -Raw|ConvertFrom-Json
 Set-UpdateStatus $JobDirectory 'staging' 'Preparing candidate and complete rollback installer.'
 $candidate=Join-Path $JobDirectory 'candidate.msi';$rollback=Join-Path $JobDirectory 'rollback.msi'
 if($r.localPackage){
  Copy-Item -LiteralPath $r.localPackage $candidate;Assert-UpdateHash $candidate $r.sha256
  $version=(Get-MsiIdentity $candidate).ProductVersion
 }else{
  $manifestPath=Join-Path $JobDirectory 'manifest.json';Get-HttpsResource $r.feedUrl $manifestPath
  $manifest=Get-Content $manifestPath -Raw|ConvertFrom-Json
  if($manifest.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid release version'}
  $version=$manifest.version
  Get-HttpsResource $manifest.url $candidate;Assert-UpdateHash $candidate $manifest.sha256;Assert-UpdateSigner $candidate $r.signer
 }
 if($r.rollbackPackage){
  Copy-Item -LiteralPath $r.rollbackPackage $rollback;Assert-UpdateHash $rollback $r.rollbackSha256
 }else{
  $previous=Join-Path $updates 'last-good.msi'
  if(!(Test-Path $previous)){throw 'No complete rollback MSI retained. Select the currently installed version installer first.'}
  Copy-Item $previous $rollback
  Assert-UpdateSigner $rollback $r.signer
 }
 Invoke-HomeMcpTransaction $JobDirectory $root $candidate $rollback $version
}catch{
 # The transaction writes rolled_back / recovery_required itself; preserve that outcome.
 $statusPath=Join-Path $JobDirectory 'status.json'
 $phase=if(Test-Path $statusPath){(Get-Content $statusPath -Raw|ConvertFrom-Json).phase}else{''}
 if($phase -notin @('failed','rolled_back','recovery_required')){Set-UpdateStatus $JobDirectory 'failed' $_.Exception.Message}
 $_|Out-String|Set-Content (Join-Path $JobDirectory 'error.log')
 exit 1
}finally{if($lock){$lock.Dispose()}}
