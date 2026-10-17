$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
$data=Join-Path $env:LOCALAPPDATA 'HomeMCP'
$config=Join-Path $data 'config.json'
New-Item -ItemType Directory -Force $data | Out-Null
if (!(Test-Path $config)) {
  & (Join-Path $PSScriptRoot 'provision-installed.ps1') -AppDir $app -ConfigPath $config
}
$node=Join-Path $app 'runtime\node.exe'
if (!(Test-Path $node)) { throw 'HomeMCP runtime missing' }
$runner=Join-Path $app 'runtime\HomeMCP.JobRunner.exe'
if (!(Test-Path $runner)) { throw 'HomeMCP JobRunner is missing; cannot ensure cleanup of child processes' }
$env:HOMEMCP_JOB_RUNNER=$runner
& $node (Join-Path $app 'src\server.mjs') --config $config