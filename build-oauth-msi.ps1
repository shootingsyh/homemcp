$ErrorActionPreference='Stop'
$src='C:\Users\shoot\source\homemcp-approval-release'
$root='C:\Users\shoot\source\homemcp'
$payload=Join-Path $root 'build\payload'
foreach($folder in @('src','web','scripts','test')) {
 Copy-Item (Join-Path $src "$folder\*") (Join-Path $payload $folder) -Recurse -Force
}
$frpc=Join-Path $src 'vendor\frp\frpc.exe'
if(!(Test-Path $frpc)){
 $tmpZip=Join-Path $env:TEMP 'homemcp-frp-0.68.0.zip'
 Invoke-WebRequest -Uri 'https://github.com/fatedier/frp/releases/download/v0.68.0/frp_0.68.0_windows_amd64.zip' -OutFile $tmpZip
 if((Get-FileHash $tmpZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '959f13d0d5f17040c3e79c3d9885dc0f43e5503619ea81b123babc3daf4dbeb6'){throw 'FRP archive checksum mismatch'}
 $extract=Join-Path $env:TEMP 'homemcp-frp-extract'
 Expand-Archive -Path $tmpZip -DestinationPath $extract -Force
 $found=Get-ChildItem $extract -Recurse -Filter frpc.exe | Select-Object -First 1
 if(!$found){throw 'FRP executable missing from archive'}
 New-Item -ItemType Directory -Force (Split-Path $frpc -Parent) | Out-Null
 Copy-Item $found.FullName $frpc -Force
}
if((Get-FileHash $frpc -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6e89b763cd4dd79f0c3082f09813efbd3dac4374a95455fe86ed27c363309a45'){throw 'FRP binary checksum mismatch'}
Copy-Item $frpc (Join-Path $payload 'runtime\frpc.exe') -Force
$frpDll=Join-Path $src 'build\homemcp-frp.dll'
if(!(Test-Path $frpDll)){throw 'Native FRP DLL missing: build from pinned frp v0.68.0 first'}
Copy-Item $frpDll (Join-Path $payload 'runtime\homemcp-frp.dll') -Force
Copy-Item (Join-Path $src 'package.json') (Join-Path $payload 'package.json') -Force
Copy-Item (Join-Path $src 'node_modules\*') (Join-Path $payload 'node_modules') -Recurse -Force
Remove-Item (Join-Path $payload 'node_modules\.bin') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $src 'build\manager-publish\HomeMCP.Manager.exe') (Join-Path $payload 'runtime\HomeMCP.Manager.exe') -Force
$generator=Get-Content (Join-Path $src 'packaging\generate-wix.ps1') -Raw
$generator=$generator.Replace('Version="0.1.27"','Version="0.1.28"')
$generated=Join-Path $root 'build\generate-wix-oauth-027.ps1'
[IO.File]::WriteAllText($generated,$generator,[Text.UTF8Encoding]::new($false))
$wxs=Join-Path $root 'build\HomeMCP-027.generated.wxs'
& $generated -Payload $payload -Output $wxs
if(!(Test-Path $wxs)){throw 'Manifest generation failed'}
if(!(Test-Path (Join-Path $payload 'src\oauth.mjs')) -or !(Test-Path (Join-Path $payload 'web\oauth.html'))) {throw 'OAuth files absent'}
$out=Join-Path $root 'dist\HomeMCP-0.1.28-x64.msi'
& 'C:\Users\shoot\.dotnet\dotnet.exe' (Join-Path $root 'build\tools\.store\wix\6.0.2\wix\6.0.2\tools\net6.0\any\wix.dll') build $wxs -arch x64 -o $out
if($LASTEXITCODE -ne 0){throw 'Wix build failed'}
Write-Host "BUILT=$out SIZE=$((Get-Item $out).Length)"
