# macOS vs Windows feature parity audit (2026-10-20)

Status: **not feature equivalent**. macOS has a working architectural foundation, not the Windows product shell. Shared Node MCP Host provides most of the backend.

| Feature | Windows | macOS | Work required |
| --- | --- | --- | --- |
| MCP host, OAuth/PKCE, Passkey server, approval execution | Shared Node Host | Shared Node Host | macOS end-to-end browser/passkey testing |
| MCP browser | Edge Playwright worker | Chrome Playwright worker | Validate selectors/session behavior |
| Native desktop tools | Windows MCP worker | No desktop worker | macOS screen/accessibility worker, TCC permission UX |
| Local service lifecycle | WinForms Manager + Windows Job | launchd LaunchAgent | macOS GUI, diagnostics, restart/recovery |
| Vault | DPAPI | Keychain helper | Real macOS Keychain tests |
| Managed tunnel and assigned subdomain | FRP DLL + Oracle API client | No managed tunnel setup | Native frpc/portable FRP, credential storage, enrollment/claim, TLS routing |
| BYOT HTTPS configuration and preflight | Manager wizard + challenge endpoint | No wizard | Shared host challenge, macOS setup CLI/UI, safe public-domain validation |
| OAuth issuer domain binding | Windows Manager workflow | Config can hold values, no workflow | Atomic binding with backup and re-enrollment warning |
| Passkey QR and add device | Local /setup invitation and /passkeys | Host routes shared | Provide accessible macOS UX, real phone test |
| Restore retained configuration | Windows files retained | macOS provision preserves config | Validation, backup, launchd repair |
| Managed recovery after OS wipe | Cloud Recovery Key API not implemented | Not implemented | Shared control plane feature first |
| Installer | MSI, manager binary | install.sh, launchd | Signed/notarized .pkg/.dmg and upgrade/uninstall |
| Tests | Windows runtime proven | macOS health smoke script | Physical Mac integration suite |

## Implementation order
1. **Common setup contract** shared across platforms: managed vs BYOT, origin validation, tunnel challenge, OAuth metadata, persistent setup status. No Windows-only logic in core.
2. **macOS setup entry point**: CLI first, then native GUI; reuse existing /setup QR page. Never complete BYOT setup without successful real HTTPS verification.
3. **Managed macOS transport**: bundled native frpc launched under launchd, secure credentials in Keychain, Oracle enrollment; keep managed domain separate from BYOT.
4. **macOS desktop worker**, TCC permissions and approval policy parity.
5. **Packaging and real macOS device E2E**: signed binary, launchd restart, QR/Passkey from phone, existing config reinstall, BYOT and managed network.
6. **Recovery Key** is a cross-platform cloud API dependency and must not be presented as complete on either platform.

Security: user-supplied BYOT URLs must not become an SSRF proxy; keep TLS validation, no redirect, public-only DNS, and bind challenge to current installation. macOS passkeys/OAuth remain local; BYOT must never contact api.homemcp.si.

## 2026-10-20 follow-up implementation
- Shared HomeMCP Worker supports stdio MCP, with fake-process integration tests. macOS can opt in to three read-only Swift desktop tools.
- macOS SwiftUI Manager source added for status, BYOT, retained-config restore and local Passkey QR; developer build produces an unsigned app (not yet compiled on a Mac).
- BYOT setup now stages the prospective OAuth issuer, restarts its LaunchAgent, checks a pinned-DNS HTTPS challenge and OAuth metadata, then rolls back on failed verification.
- macOS Oracle tunnel state uses the macOS Keychain helper; Windows DPAPI paths remain unchanged. Managed FRP process orchestration is still missing.
- An unsigned developer .pkg build recipe now includes the Manager bundle and Node sources/dependencies when available. Signing, notarization, portable Node and installation lifecycle integration are not complete.
- No physical macOS E2E, accessibility permission validation or production package verification has occurred.

## Managed tunnel launchd foundation
macOS Oracle credentials use Keychain-backed per-device storage; scripts/oracle-tunnel.mjs can reuse the existing enroll/claim/certificate control-plane API without cloud protocol changes. scripts/oracle-run.mjs now accepts macOS paths and a separately installed native frpc binary. scripts/macos/write-managed-launchagents.mjs creates two credential-free launchd descriptors for the HTTPS gateway and FRP worker, but refuses to proceed unless the managed origin, bootstrap, tenant credentials, certificate and binaries already exist. No auto-enrollment or charge is performed. The required secure orchestration (purchase/claim -> origin bind -> launchd bootstrap -> health check -> rollback) is NOT implemented and cannot be marked feature parity.
