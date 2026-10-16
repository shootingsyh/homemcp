# HomeMCP requirements and architecture (draft 0.1)
HomeMCP is a Windows-first packaged local MCP runtime, not a generic MCP provider registry.
Goals: zero manual prerequisites, private pinned runtimes, install/repair/upgrade/uninstall, login-autostart, reliable worker lifecycle and low CPU overhead.
## Architecture
Muse App / ChatGPT -> authenticated local MCP Host -> fixed policy/HITL -> on-demand Playwright MCP and Windows-MCP.
The Host stays alive while idle. Worker activation and repair occur on a real tool call; process exit signals mark workers as unavailable. No idle high-frequency reconciliation loop. Bind workers to dynamic loopback ports; never adopt a process based solely on name or port. Only stop descendant processes created by this installation.
Host and desktop automation must run in a logged-in interactive user session. Future privileged control-plane services may run before login, but must not perform desktop UI automation in Session 0.
## Installer
Ship version-pinned private Node/Python/Playwright/Windows-MCP; never overwrite global tools. Configure at first start, protect tokens via Windows ACL or OS vault, reserve/update dynamic ports. MSI upgrade should be rollback-safe; Windows Installer alone does not provide an auto-updater. Validate offline, partial/stale installs, port conflicts, sign-in/logout, and cleanup in Hyper-V.
## Security
Remote access disabled until end-to-end auth is tested. Tool-level ALLOW/ASK/DENY, default DENY; approval is bound to the exact tool and arguments. Use real WebAuthn user verification; mobile Face ID, Android biometrics and Touch ID are backed by passkeys. Approval URLs, email and SMS are notification/recovery tools, not sufficient authentication for credentials, arbitrary shell or money movement. Never record passwords, bearer tokens or cookie values.
## External integrations
Muse App Password Store: user needs credential delegation to fill approved site forms; exact Muse API availability remains unverified. Do not assume HomeMCP can export Muse secrets. Payment/Plaid integrations are out of first-release scope; use explicit payee/amount authorization and sandbox testing.
## Release milestones
M0 Windows Hyper-V test lab; M1 MSI and pinned dependencies; M2 Supervisor/browser/desktop E2E; M3 secure local HITL/passkeys; M4 signed release and updater; M5 optional remote transports and cross-platform adapters.
