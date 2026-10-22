param([Parameter(Mandatory)][string]$AppDir,[Parameter(Mandatory)][string]$ConfigPath)
$ErrorActionPreference='Stop'
if (Test-Path $ConfigPath) { return }
function Free-Port([int[]]$Exclude=@()) {
 for($i=0;$i -lt 40;$i++) {
  $listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
  try {$listener.Start();$p=[int]$listener.LocalEndpoint.Port} finally {$listener.Stop()}
  if($p -notin $Exclude) {return $p}
 }
 throw 'Failed to allocate local port'
}
function New-Token {
 $bytes=New-Object byte[] 32
 $rng=[System.Security.Cryptography.RandomNumberGenerator]::Create()
 try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
 return ([BitConverter]::ToString($bytes)).Replace('-','')
}
$hostPort=Free-Port
$browserPort=Free-Port @($hostPort)
$desktopPort=Free-Port @($hostPort,$browserPort)
$dataDir=Split-Path $ConfigPath -Parent
$config=@{
 installationId=([Guid]::NewGuid().ToString('N'));host='127.0.0.1';port=$hostPort;dataDir=(Join-Path $dataDir 'data');token=(New-Token)
 security=@{adminToken=(New-Token);approvalTimeoutMs=600000;policy=@{browser_navigate='allow';browser_snapshot='allow';desktop_Snapshot='allow';desktop_Screenshot='allow';desktop_Click='allow';desktop_Type='allow';desktop_Scroll='allow';desktop_Move='allow';desktop_Shortcut='allow';desktop_Wait='allow';desktop_WaitFor='allow';desktop_App='allow';desktop_PowerShell='allow'}}
 egress=@{enabled=$false;mode='disabled'}
 workers=@(
  @{name='browser';command=(Join-Path $AppDir 'runtime\node.exe');args=@((Join-Path $AppDir 'workers\playwright\cli.mjs'),'--browser','msedge','--user-data-dir',(Join-Path $dataDir 'EdgeProfile'),'--shared-browser-context','--host','127.0.0.1','--port',([string]$browserPort));url="http://127.0.0.1:$browserPort/mcp";startupMs=35000},
  @{name='desktop';command=(Join-Path $AppDir 'workers\windows-mcp.exe');args=@('serve','--transport','streamable-http','--host','127.0.0.1','--port',([string]$desktopPort),'--tools','Screenshot,Snapshot,Click,Type,Scroll,Move,Shortcut,Wait,WaitFor,App,PowerShell');url="http://127.0.0.1:$desktopPort/mcp";startupMs=35000}
 )
 tools=@{
  browser_navigate=@{worker='browser';upstream='browser_navigate';description='Browser navigate';inputSchema=@{type='object';properties=@{url=@{type='string'}};required=@('url')}}
  browser_snapshot=@{worker='browser';upstream='browser_snapshot';description='Browser snapshot';inputSchema=@{type='object';properties=@{}}}
  desktop_Snapshot=@{worker='desktop';upstream='Snapshot';description='Desktop snapshot';inputSchema=@{type='object';properties=@{}}}
  desktop_Screenshot=@{worker='desktop';upstream='Screenshot';description='Desktop screenshot';inputSchema=@{type='object';properties=@{}}}
  desktop_Click=@{worker='desktop';upstream='Click';description='Windows desktop Click';inputSchema=@{type='object';properties=@{loc=@{type='array';items=@{type='integer'}};label=@{type='integer'};button=@{type='string'};clicks=@{type='integer'}}}}
  desktop_Type=@{worker='desktop';upstream='Type';description='Windows desktop Type';inputSchema=@{type='object';properties=@{loc=@{type='array';items=@{type='integer'}};label=@{type='integer'};text=@{type='string'};clear=@{type='boolean'};press_enter=@{type='boolean'};caret_position=@{type='string'}}}}
  desktop_Scroll=@{worker='desktop';upstream='Scroll';description='Windows desktop Scroll';inputSchema=@{type='object';properties=@{loc=@{type='array';items=@{type='integer'}};label=@{type='integer'};type=@{type='string'};direction=@{type='string'};wheel_times=@{type='integer'}}}}
  desktop_Move=@{worker='desktop';upstream='Move';description='Windows desktop Move';inputSchema=@{type='object';properties=@{loc=@{type='array';items=@{type='integer'}};label=@{type='integer'};drag=@{type='boolean'};from_loc=@{type='array';items=@{type='integer'}};duration=@{type='number'}}}}
  desktop_Shortcut=@{worker='desktop';upstream='Shortcut';description='Windows desktop Shortcut';inputSchema=@{type='object';properties=@{shortcut=@{type='string'}}}}
  desktop_Wait=@{worker='desktop';upstream='Wait';description='Windows desktop Wait';inputSchema=@{type='object';properties=@{duration=@{type='integer'}}}}
  desktop_WaitFor=@{worker='desktop';upstream='WaitFor';description='Windows desktop WaitFor';inputSchema=@{type='object';properties=@{condition=@{type='string'};text=@{type='string'};window_name=@{type='string'};timeout=@{type='integer'}}}}
  desktop_App=@{worker='desktop';upstream='App';description='Windows desktop App';inputSchema=@{type='object';properties=@{mode=@{type='string'};name=@{type='string'};executable=@{type='string'};args=@{type='array';items=@{type='string'}};cwd=@{type='string'};window_loc=@{type='array';items=@{type='integer'}};window_size=@{type='array';items=@{type='integer'}}}}}
  desktop_PowerShell=@{worker='desktop';upstream='PowerShell';description='Windows desktop PowerShell';inputSchema=@{type='object';properties=@{command=@{type='string'};timeout=@{type='integer'}}}}
 }
}
$tmp="$ConfigPath.tmp.$PID"
[IO.File]::WriteAllText($tmp,($config|ConvertTo-Json -Depth 18),[Text.UTF8Encoding]::new($false))
Move-Item $tmp $ConfigPath
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $ConfigPath /inheritance:r /grant:r "$($identity):(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue; throw 'Failed to protect installed secrets' }
Write-Host "HomeMCP prepared on 127.0.0.1:$hostPort. Remote access disabled."