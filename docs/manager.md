# HomeMCP Manager (Windows)

The MSI bundles a lightweight, self-contained Windows Forms tray application, `HomeMCP.Manager.exe`. At the next user sign-in the HKCU Run entry starts the Manager, which starts HomeMCP itself. The Manager stays alive when the MCP Host is stopped, and owns its child process tree.

Double-click the tray icon for the native **Settings** window. Start, Stop and Restart control only the new HomeMCP process; other MCPs and existing Cloudflare processes are never killed by name. The external HTTPS address field saves the requested address to the local network preferences file, but intentionally does not change DNS or expose the Host. The tunnel button opens the existing first-run network setup wizard.

A PowerShell CLI uses a local **same-user named pipe**, without binding an administrative HTTP API on the public-facing MCP listener:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\HomeMCP\app\scripts\homemcp.ps1" status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\HomeMCP\app\scripts\homemcp.ps1" restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\HomeMCP\app\scripts\homemcp.ps1" settings
```

Supported CLI verbs: `status`, `start`, `stop`, `restart`, `settings`. The Manager must be running for the CLI to connect. This is intentionally **not** a remotely callable management API.

Implementation boundaries: the settings UI is **native Windows Forms, not a browser dashboard yet**; tunnel configuration changes are saved for later validation and do not immediately expose the local listener. First install does not automatically migrate any previous Airlock, Playwright or Windows-MCP processes. A green Windows MSI CI run and manual interactive tray smoke test are required before recommending migration.
