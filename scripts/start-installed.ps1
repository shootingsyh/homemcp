$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
$node=Join-Path $app 'runtime\node.exe'
$config=Join-Path $env:LOCALAPPDATA 'HomeMCP\config.json'
if (!(Test-Path $config)) {throw 'HomeMCP config missing; reinstall/repair'}
& $node (Join-Path $app 'src\server.mjs') --config $config