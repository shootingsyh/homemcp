# Windows Manager UI alignment

The Windows dashboard follows the macOS Manager's connection flow while keeping WinForms and existing Host supervision:

| Entry | Windows behavior |
| --- | --- |
| MCP endpoint / Copy URL | Read the current publicUrl, accept a bare HTTPS origin, append /mcp, and copy only that URL |
| Connect ChatGPT | Separate resizable OAuth setup walkthrough, copy URL, open ChatGPT |
| Connect Muse | Separate resizable setup prompt, copy URL and prompt, including HomeMCP Passkey approval handling |
| Connect another device / Manage devices | Existing trusted enrollment and Passkey management operations |
| Check Status / Start / Stop / Restart | Existing health check and process supervision |
| Show diagnostics | Expand the existing component/runtime/tunnel details |
| Restart Setup Wizard | Preserve Host configuration and credentials; existing reset behavior |

Tray menu also exposes both connection guides. Missing or malformed public origins disable URL copying; Muse prompt copying remains disabled until configured.

Scope: this aligns the ready dashboard and connection guides. Windows Managed setup still supports existing enrollments only. macOS desktop permissions are platform-specific. The macOS updater is a separate change (PR #4); this UI change does not claim new Windows update functionality.

Validation: build Manager.csproj on Windows with .NET 8. Set HOMEMCP_UI_SMOKE=1 and HOMEMCP_UI_SMOKE_PAGE to wizard or dashboard to exercise actual WinForms controls without starting the Host/tunnel. HOMEMCP_UI_SMOKE_MARKER records success. HOMEMCP_UI_SMOKE_SCREENSHOT optionally writes a rendered window PNG; dashboard mode also writes a .guide.png for visual inspection. Smoke uses a separate single-instance mutex and never replaces the installed Manager.

After phone enrollment, the dashboard automatically runs `scripts/windows-desktop-self-test.mjs` against the installed loopback Host using the local MCP credential. It invokes the actual Screenshot and Snapshot tools and only reports desktop control ready when both return usable content. The dashboard also provides Test Desktop Again. A worker timeout, missing tool, capture error or pending approval remains a failure; timeout is not described as proof of missing permission. No pixels or window titles are included in the report, and no apps are opened, input injected, UAC elevation requested or Host/worker restarted by this probe. UI smoke mode suppresses real desktop tests. This validates local desktop actions, not remote OAuth/tunnel connectivity or access to every elevated application.
