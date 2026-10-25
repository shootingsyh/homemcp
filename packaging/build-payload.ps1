$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'copy-dependencies.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$payload = Join-Path $root 'build\payload'
New-Item -ItemType Directory -Force "$payload\runtime", "$payload\workers\playwright", "$payload\scripts", "$payload\src", "$payload\web", "$payload\test", "$root\dist" | Out-Null
Copy-Item "$root\src\*" "$payload\src" -Recurse -Force
Copy-Item "$root\web\*" "$payload\web" -Recurse -Force
Copy-Item "$root\test\*" "$payload\test" -Recurse -Force
Copy-Item "$root\scripts\*" "$payload\scripts" -Recurse -Force
Copy-Item "$root\package.json" "$payload\package.json"
Copy-HomeMCPDependencies "$root\node_modules" "$payload\node_modules"
$nodeUrl = 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-win-x64.zip'
Invoke-WebRequest $nodeUrl -OutFile "$root\build\node.zip"
Expand-Archive "$root\build\node.zip" -DestinationPath "$root\build\node-dist" -Force
Copy-Item "$root\build\node-dist\node-v22.16.0-win-x64\node.exe" "$payload\runtime\node.exe"
$pwPkg = '@playwright/mcp@0.0.48'
New-Item -ItemType Directory -Force "$root\build\pw" | Out-Null
Push-Location "$root\build\pw"
try {
  npm.cmd init -y | Out-Null
  npm.cmd install --no-audit --no-fund --ignore-scripts $pwPkg
  if ($LASTEXITCODE -ne 0) { throw 'Playwright dependency install failed' }
  Copy-HomeMCPDependencies (Join-Path (Get-Location) 'node_modules') "$payload\workers\playwright\node_modules"
} finally { Pop-Location }
@'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('./node_modules/@playwright/mcp/package.json');
const entry = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
await import(new URL(entry, new URL('./node_modules/@playwright/mcp/', import.meta.url)));
'@ | Set-Content "$payload\workers\playwright\cli.mjs" -Encoding UTF8
# Install the official CPython embeddable runtime, not a PyInstaller executable.
# The desktop worker uses a dedicated interpreter and fixed Python dependencies.
& py -3.14 --version
if ($LASTEXITCODE -ne 0) { throw 'Python 3.14 required on BUILD runner' }
$worker=Join-Path $payload 'workers\windows-mcp'
New-Item -ItemType Directory -Force $worker | Out-Null
$pythonVersion='3.14.2'
$pythonZip=Join-Path $root 'build\python-embed.zip'
Invoke-WebRequest "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip" -OutFile $pythonZip
Expand-Archive $pythonZip -DestinationPath $worker -Force
# Python embeddable _pth deliberately disables user/global PYTHONPATH.
# Only bundled wheels and the standard library are visible to the worker.
$pth=Get-ChildItem $worker -Filter 'python*._pth' | Select-Object -First 1
if (-not $pth) { throw 'Python embedded ._pth file missing' }
Set-Content -LiteralPath $pth.FullName -Encoding ASCII -Value @('python314.zip','.','site-packages','import site')
New-Item -ItemType Directory -Force (Join-Path $worker 'site-packages') | Out-Null
& py -3.14 -m pip install --disable-pip-version-check --no-compile --target (Join-Path $worker 'site-packages') 'windows-mcp==0.8.8'
if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP wheel install failed' }
# pywin32's wheel expects its custom site initialization, which the embedded
# interpreter does not run. Expose win32 modules and required native DLLs.
Add-Content -LiteralPath $pth.FullName -Encoding ASCII -Value @('site-packages\\win32','site-packages\\win32\\lib','site-packages\\Pythonwin')
foreach ($name in @('pywintypes314.dll','pythoncom314.dll')) {
  $src = Join-Path $worker "site-packages\\pywin32_system32\\$name"
  if (-not (Test-Path $src)) { throw "Windows-MCP pywin32 runtime missing $name" }
  Copy-Item $src (Join-Path $worker $name) -Force
}

# Exclude the desktop worker's own noninteractive overlay HWNDs before UIA.
& (Join-Path $worker 'python.exe') (Join-Path $root 'scripts\patch-windows-snapshot.py') (Join-Path $worker 'site-packages')
if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP snapshot overlay patch failed' }

& (Join-Path $worker 'python.exe') (Join-Path $root 'scripts\patch-windows-indicator.py') (Join-Path $worker 'site-packages')
if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP indicator progress patch failed' }
& (Join-Path $worker 'python.exe') (Join-Path $root 'test\test_windows_indicator_bitmap.py')
if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP indicator/GDI regression failed' }

& (Join-Path $worker 'python.exe') (Join-Path $root 'scripts\patch-windows-powershell.py') (Join-Path $worker 'site-packages')
if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP background command capture patch failed' }
& (Join-Path $worker 'python.exe') (Join-Path $root 'test\test_windows_powershell_capture.py')
if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP background command regression failed' }

& (Join-Path $worker 'python.exe') -c "import windows_mcp; print('BUNDLED_WINDOWS_MCP_OK')"
if ($LASTEXITCODE -ne 0) { throw 'Embedded Python smoke test failed' }
dotnet publish "$root\native\Manager\Manager.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o "$root\build\manager"
if ($LASTEXITCODE -ne 0) { throw 'Manager publish failed' }
Copy-Item "$root\build\manager\HomeMCP.Manager.exe" "$payload\runtime\HomeMCP.Manager.exe" -Force
& "$root\packaging\generate-wix.ps1" -Payload $payload -Output "$root\build\HomeMCP.generated.wxs"
if ($LASTEXITCODE -ne 0) { throw 'WiX manifest generation failed' }

