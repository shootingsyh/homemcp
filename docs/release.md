# Windows MSI candidate release
WiX Toolset 6 on GitHub Actions windows-latest is used to produce an MSI candidate. The build is not a stable release until a Windows runner succeeds, smoke test checks packaged Node/Playwright/Windows-MCP and clean-install/upgrade/uninstall tests pass.
The first version is a **local-only development preview**; do not enable Cloudflare ingress. A production release additionally requires process-tree lifecycle hardening, signed binaries, private-runtime version pinning, authenticated update feed and rollback, real Passkey verification and a full Windows desktop E2E.
Do not publish to Releases or promise one-click production installation merely because WiX compiled.
