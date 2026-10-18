$ErrorActionPreference='Stop'
try {
 $app=Split-Path $PSScriptRoot -Parent
 $data=Join-Path $env:LOCALAPPDATA 'HomeMCP'
 $config=Join-Path $data 'config.json'
 New-Item -ItemType Directory -Force $data | Out-Null
 if (!(Test-Path $config)) {
   & (Join-Path $PSScriptRoot 'provision-installed.ps1') -AppDir $app -ConfigPath $config
 }
 $node=Join-Path $app 'runtime\node.exe'
 if (!(Test-Path $node)) { throw 'HomeMCP runtime missing' }
 $bridge=@()
 try {
  $bridgeConfig=Join-Path $data 'cloudflared\config.yml'
  $proxyScript=Join-Path $data 'protected-proxy.mjs'
  if ((Test-Path $bridgeConfig) -and (Test-Path $proxyScript)) {
   $cloud=Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet') -Filter 'cloudflared.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
   if (!$cloud) {throw 'HomeMCP Cloudflare enabled but cloudflared.exe missing'}
   $bridge+=Start-Process -FilePath $node -ArgumentList @($proxyScript) -PassThru -WindowStyle Hidden
   $bridge+=Start-Process -FilePath $cloud -ArgumentList @('tunnel','--config',('"' + $bridgeConfig + '"'),'run') -PassThru -WindowStyle Hidden
  }
  & $node (Join-Path $app 'src\server.mjs') --config $config
  if ($LASTEXITCODE -ne 0) { throw "HomeMCP Node host exited with code $LASTEXITCODE" }
 } finally {
  foreach($child in $bridge) {
   try {if (!$child.HasExited) {Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue}} catch {}
   $child.Dispose()
  }
 }
} catch {
 try {
  $logDir=Join-Path $env:LOCALAPPDATA 'HomeMCP\logs'
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $description=$_.Exception.Message
  Add-Content -LiteralPath (Join-Path $logDir 'startup-errors.log') -Value ("$(Get-Date -Format o) : $description")
 } catch {}
 throw
}
