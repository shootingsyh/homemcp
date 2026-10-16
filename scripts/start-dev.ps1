param([string]$Destination="$env:LOCALAPPDATA\HomeMCP-dev")
$ErrorActionPreference='Stop'
$config=Join-Path $Destination 'config.json';if(!(Test-Path $config)){throw 'Run install-dev.ps1 first'}
& node.exe (Join-Path $Destination 'src\server.mjs') --config $config