param([Parameter(Mandatory)][string]$Candidate,[Parameter(Mandatory)][string]$Job)
$ErrorActionPreference='Stop'
$probe=Join-Path $Job 'probe';New-Item -ItemType Directory $probe -Force|Out-Null
$configPath=Join-Path $probe 'config.json'
# Provision fresh loopback ports, tokens, data directory and browser profile.
# Production config/credentials are never passed to the candidate Host.
& (Join-Path $Candidate 'scripts\provision-installed.ps1') -AppDir $Candidate -ConfigPath $configPath|Out-Null
$config=Get-Content $configPath -Raw|ConvertFrom-Json
$base='http://127.0.0.1:'+$config.port
$hostProcess=$null
try{
 $hostProcess=Start-Process (Join-Path $Candidate 'runtime\node.exe') -ArgumentList @(('"'+(Join-Path $Candidate 'src\server.mjs')+'"'),'--config',('"'+$configPath+'"')) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $probe 'host.stdout.log') -RedirectStandardError (Join-Path $probe 'host.stderr.log')
 $ready=$false
 for($i=0;$i -lt 60;$i++){
  if($hostProcess.HasExited){throw 'Candidate Host exited during isolated probe'}
  try{
   $health=Invoke-RestMethod ($base+'/health') -TimeoutSec 2
   if($health.ok){$ready=$true;break}
  }catch{}
  Start-Sleep -Seconds 1
 }
 if(!$ready){throw 'Candidate Host/workers did not become ready'}
 $headers=@{Authorization=('Bearer '+$config.token);Accept='application/json, text/event-stream'}
 $init=@{jsonrpc='2.0';id=1;method='initialize';params=@{protocolVersion='2025-03-26';capabilities=@{};clientInfo=@{name='update-probe';version='1'}}}|ConvertTo-Json -Depth 8
 $response=Invoke-RestMethod ($base+'/mcp') -Headers $headers -Method Post -ContentType 'application/json' -Body $init -TimeoutSec 10
 if(!$response.result.protocolVersion){throw 'Candidate MCP initialization failed'}
 $body=@{jsonrpc='2.0';id=2;method='tools/list';params=@{}}|ConvertTo-Json
 $response=Invoke-RestMethod ($base+'/mcp') -Headers $headers -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
 $names=@($response.result.tools|ForEach-Object {$_.name})
 foreach($required in @('browser_navigate','browser_snapshot','desktop_Screenshot','desktop_Click')){if($required -notin $names){throw "Candidate tool missing: $required"}}
 $process=Start-Process (Join-Path $Candidate 'runtime\node.exe') -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'windows-update-workers.mjs')+'"'),('"'+$Candidate+'"'),('"'+$configPath+'"')) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $probe 'workers.stdout.log') -RedirectStandardError (Join-Path $probe 'workers.stderr.log')
 $null=$process.Handle
 if(!$process.WaitForExit(100000)){
  & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F|Out-Null
  throw 'Candidate worker discovery timed out'
 }
 $process.WaitForExit();if($process.ExitCode -ne 0){throw ('Candidate upstream discovery failed: '+(Get-Content (Join-Path $probe 'workers.stderr.log') -Raw))}
 Write-Output 'CANDIDATE_HOST_AND_WORKERS_READY'
}finally{
 if($hostProcess -and !$hostProcess.HasExited){
  # Kill only the process tree created by this probe, never production node/python.
  & "$env:SystemRoot\System32\taskkill.exe" /PID $hostProcess.Id /T /F|Out-Null
  $null=$hostProcess.WaitForExit(10000)
 }
 if($hostProcess){$hostProcess.Dispose()}
}
