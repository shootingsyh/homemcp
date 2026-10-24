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
