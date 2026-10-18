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

### Agent-controlled credentials (Windows)
HomeMCP optionally exposes `credential_save` and `credential_fill` when
`security.credentialVaultEnabled` is explicitly set to `true` in the installed
configuration. An authenticated Muse client calls `credential_save` with the
*exact HTTPS origin*, username and password. Passwords are encrypted using
Windows DPAPI CurrentUser before being stored in a separate SQLite database;
existing credentials require `replace: true` to overwrite.

`credential_fill` takes `origin`, `username`, `username_selector`, and
`password_selector` (CSS selectors). The browser worker checks the *actual
current page origin* and both unique, visible input types in the same browser
execution before filling. Only a nonsecret fill status is returned. The site
itself can read submitted credentials; use only trusted login origins. Password
contents are never put into the standard Passkey approval queue. Normal
browser tools cannot retrieve the vault; no plaintext export tool is provided.
