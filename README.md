# HomeMCP

Windows-first MCP runtime providing a fixed Browser/Windows Desktop tool surface with on-demand worker supervision, dynamic loopback ports and local human approval.

**Status: pre-release source. Not an installable, tested MSI yet. Do not expose to public internet.**

## Repo contents

- `src/`: Host, MCP client, owned-worker supervisor, remote egress adapter (disabled by default), SQLite HITL, WebAuthn Passkey integration.
- `web/`: local-only approval UI.
- `test/`: unit and local integration tests.
- `scripts/`: development installation, local provisioning, smoke test and launcher.
- `packaging/`: WiX 6 MSI payload construction, candidate build and manifest generation.
- `.github/workflows/windows-msi.yml`: Windows candidate pipeline; **not yet verified end-to-end**.

Development only (Node.js 22+ must be installed):
```powershell
npm.cmd install
npm.cmd test
powershell -ExecutionPolicy Bypass -File .\scripts\install-dev.ps1
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\HomeMCP-dev\scripts\start-dev.ps1"
```

The development installer uses the user's globally installed workers; the MSI *build* is designed to bundle private runtimes. Neither should replace existing Airlock or modify the user's active MCP services.

The MSI candidate cannot be considered zero-dependency or auto-updating until its Windows build, clean install, stop/upgrade/uninstall and real Browser/Desktop E2E tests pass. See [design](docs/design.md), [MSI status](docs/msi-status.md) and [release gates](docs/release.md).

## Windows tray and local settings

The Windows MSI includes a lightweight tray manager with Start/Stop/Restart and native Settings. See [manager usage](docs/manager.md). CLI uses a current-user-only named pipe. External URL configuration does not automatically expose your computer; Cloudflare setup remains opt-in.
