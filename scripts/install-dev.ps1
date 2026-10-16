param([string]$Destination="$env:LOCALAPPDATA\HomeMCP-dev")
$ErrorActionPreference='Stop'
if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node 22+ required for development install. Release installer will bundle it.' }
$version=[int]((node -p 'process.versions.node').Split('.')[0]); if($version -lt 22){throw 'Node 22+ needed'}
function Get-FreeLocalPort {
 param([int[]]$Exclude = @())
 for ($i=0; $i -lt 50; $i++) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try { $listener.Start(); $p = [int]$listener.LocalEndpoint.Port } finally { $listener.Stop() }
  if ($p -notin $Exclude) { return $p }
 }
 throw 'Failed to find three distinct local ports'
}
$source=Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force $Destination | Out-Null
Copy-Item "$source\src" "$Destination\src" -Recurse -Force
Copy-Item "$source\scripts" "$Destination\scripts" -Recurse -Force
Copy-Item "$source\web" "$Destination\web" -Recurse -Force
Copy-Item "$source\package.json" "$Destination\package.json" -Force
Write-Host "Run npm.cmd install in $Destination to install pinned WebAuthn verifier dependency before starting."
$configPath=Join-Path $Destination 'config.json'
if(!(Test-Path $configPath)) {
 $bytes=New-Object byte[] 32
 [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
 $token=([BitConverter]::ToString($bytes)).Replace('-', '')
 $hostPort = Get-FreeLocalPort
 $browserPort = Get-FreeLocalPort -Exclude @($hostPort)
 $desktopPort = Get-FreeLocalPort -Exclude @($hostPort,$browserPort)
 [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
 $adminToken=([BitConverter]::ToString($bytes)).Replace('-', '')
 $config=@{
  installationId=([guid]::NewGuid().ToString('N'));host='127.0.0.1';port=$hostPort;dataDir=(Join-Path $Destination 'data');token=$token
  security=@{adminToken=$adminToken;approvalTimeoutMs=120000;policy=@{browser_navigate='ask';browser_snapshot='allow';desktop_Snapshot='allow';desktop_Screenshot='allow'}}
  egress=@{mode='disabled';enabled=$false}
  workers=@(
   @{name='browser';command='cmd.exe';args=@('/d','/s','/c','npx.cmd','--yes','@playwright/mcp@latest','--browser','msedge','--user-data-dir',(Join-Path $Destination 'EdgeProfile'),'--shared-browser-context','--host','127.0.0.1','--port',([string]$browserPort));url="http://localhost:$browserPort/mcp";startupMs=35000},
   @{name='desktop';command='py.exe';args=@('-3.13','-m','uv','tool','run','--from','windows-mcp','windows-mcp','serve','--transport','streamable-http','--host','127.0.0.1','--port',([string]$desktopPort),'--tools','Screenshot,Click,Snapshot');url="http://127.0.0.1:$desktopPort/mcp";startupMs=35000}
  )
  tools=@{
   browser_navigate=@{worker='browser';upstream='browser_navigate';description='Navigate browser';inputSchema=@{type='object';properties=@{url=@{type='string'}};required=@('url')}}
   browser_snapshot=@{worker='browser';upstream='browser_snapshot';description='Browser accessibility snapshot';inputSchema=@{type='object';properties=@{}}}
   desktop_Snapshot=@{worker='desktop';upstream='Snapshot';description='Desktop UI snapshot';inputSchema=@{type='object';properties=@{}}}
   desktop_Screenshot=@{worker='desktop';upstream='Screenshot';description='Desktop screenshot';inputSchema=@{type='object';properties=@{}}}
  }
 }
 $config | ConvertTo-Json -Depth 16 | Set-Content -Path $configPath -Encoding UTF8
 Write-Host "Allocated loopback ports: Host=$hostPort Browser=$browserPort Desktop=$desktopPort"
} else {Write-Host 'Existing config preserved.'}
Write-Host "Installed development files at $Destination"
