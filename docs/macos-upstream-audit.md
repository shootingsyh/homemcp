# macOS desktop MCP upstream source audit (2026-10-20)
Reviewed source snapshots (not just READMEs):
- minghinmatthewlam/computer-use-mcp at 82dd809 (MIT): Sources/computer-use-mcp/Tools/{Catalog,ClickTool,InputTools,Perception,HealthReportTool}.swift, Core/Input.swift, Core/Screenshot.swift. Swift binary exposes stdio MCP. Source implements AX/CoreGraphics interaction and capture. Claims of focus isolation, permission persistence, and reliability still require Mac live verification.
- hyprcat/mac-cua at 362393e (Apache-2.0): app/server.py uses mcp.server.stdio; app/_lib/input.py implements click and type; macOS-dependent Python/PyObjC stack. Candidate fallback, less straightforward to bundle.
Selected evaluation order: Swift first, mac-cua fallback. Do not bundle either until dependency pinning, license notices, trusted build, real Mac TCC tests and stdio bridge.
Current macOS installer is a development source-only script. package.sh produces an explicitly unsigned developer .pkg; no false claims of signed/notarized release or bundled runtime.
macOS setup.mjs is a CLI foundation, not a complete native Manager GUI. BYOT still needs a secure origin preflight architecture resistant to DNS rebind (pin resolved address during TLS request), and atomic restart/rollback testing on real macOS before release.

## Opt-in read-only desktop integration
Mac provisioning can enable the audited Swift desktop executable via HOMEMCP_MACOS_DESKTOP_WORKER pointing to an absolute path on first install. This launches a stdio MCP worker using "serve" and exposes only desktop_list_apps, desktop_get_app_state, and desktop_health_report. Mutating tools are intentionally not advertised until passkey approval previews and permissions have been designed. No third-party binary is automatically downloaded or trusted.
