$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$payload = Join-Path $root 'build\payload'
New-Item -ItemType Directory -Force "$payload\runtime", "$payload\workers\playwright", "$payload\scripts", "$payload\src", "$payload\web", "$payload\test", "$root\dist" | Out-Null
Copy-Item "$root\src\*" "$payload\src" -Recurse -Force
Copy-Item "$root\web\*" "$payload\web" -Recurse -Force
Copy-Item "$root\test\*" "$payload\test" -Recurse -Force
Copy-Item "$root\scripts\*" "$payload\scripts" -Recurse -Force
Copy-Item "$root\package.json" "$payload\package.json"
Copy-Item "$root\node_modules" "$payload\node_modules" -Recurse -Force
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
  Copy-Item 'node_modules' "$payload\workers\playwright\node_modules" -Recurse -Force
} finally { Pop-Location }
@'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('./node_modules/@playwright/mcp/package.json');
const entry = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
await import(new URL(entry, new URL('./node_modules/@playwright/mcp/', import.meta.url)));
'@ | Set-Content "$payload\workers\playwright\cli.mjs" -Encoding UTF8
& py -3.14 --version
if ($LASTEXITCODE -ne 0) { throw 'Python 3.14 is required on BUILD runner' }
& py -3.14 -m venv "$root\build\py-build"
$py = "$root\build\py-build\Scripts\python.exe"
& $py -m pip install --disable-pip-version-check 'windows-mcp==0.8.8' 'pyinstaller>=6.16,<7'
if ($LASTEXITCODE -ne 0) { throw 'Python build dependencies failed' }
@'
from windows_mcp.__main__ import main
if __name__ == "__main__":
    main()
'@ | Set-Content "$root\build\windows_mcp_entry.py" -Encoding UTF8
& $py -m PyInstaller --noconfirm --clean --onefile --name windows-mcp --collect-all windows_mcp --distpath "$payload\workers" --workpath "$root\build\pyinstaller-work" --specpath "$root\build" "$root\build\windows_mcp_entry.py"
if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP PyInstaller failed' }
dotnet publish "$root\native\JobRunner\JobRunner.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o "$root\build\jobrunner" 
if ($LASTEXITCODE -ne 0) { throw 'JobRunner publish failed' }
Copy-Item "$root\build\jobrunner\HomeMCP.JobRunner.exe" "$payload\runtime\HomeMCP.JobRunner.exe" -Force
& "$root\packaging\generate-wix.ps1" -Payload $payload -Output "$root\build\HomeMCP.generated.wxs"
if ($LASTEXITCODE -ne 0) { throw 'WiX manifest generation failed' }
