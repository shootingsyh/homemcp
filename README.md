# HomeMCP

**Connect your own computer to MCP-compatible AI assistants — with OAuth, Passkey approval, and your choice of hosted or self-hosted connectivity.**

HomeMCP is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) host that exposes browser and desktop automation tools to authorized AI clients. The tools execute **on your computer**, under a local policy and human-approval layer. HomeMCP is not a hosted remote desktop: your own machine runs the workers, holds the credentials, and enforces approvals.

> **Pre-release / source available.** Windows has been deployed and exercised on a development machine, but clean-machine installer, upgrade, and security release gates are **not yet complete**. macOS is under active development and **has not yet passed real-Mac end-to-end testing**. The project source is licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.

## How it works

```text
ChatGPT / Muse / another MCP client
                  |
               HTTPS + OAuth
                  |
       +-------------------------+
       | YOUR public endpoint    |
       | Managed or your tunnel  |
       +-------------------------+
                  |
       HomeMCP on YOUR computer
       - OAuth / PKCE
       - Passkey registration and approval
       - Tool allow / ask / deny policies
       - Local SQLite state and audit
                  |
          MCP tool workers
       Browser / desktop / more
```

## Choose a connection mode

| | HomeMCP Managed | Bring Your Own Tunnel (BYOT) |
|---|---|---|
| Who provides the HTTPS domain? | HomeMCP subdomain | You |
| Who operates the tunnel? | HomeMCP FRP | You (e.g. Cloudflare Tunnel or a reverse proxy) |
| HomeMCP cloud account/API needed? | Yes, for enrollment and tunnel | **No** |
| HomeMCP subscription? | Yes | **No HomeMCP tunnel subscription** |
| MCP authentication | Local OAuth + Passkey | **The same local OAuth + Passkey** |
| State after reinstall | Retained local configuration | Retained local configuration, or reconfigure your tunnel |
| Recovery after OS wipe | Recovery Key workflow **not yet implemented** | Recover your DNS/tunnel separately and re-enroll |

**No hybrid mode:** using HomeMCP's paid tunnel includes its HomeMCP domain. A custom domain is supported through BYOT, not through HomeMCP Managed FRP.

OAuth replaces *manually copying a static bearer token*. OAuth access tokens themselves still use bearer-token semantics. A static token remains a legacy/advanced compatibility path.

## Quick start

### Windows (development / pre-release)

**Requirements:** Windows 11, a working browser, and PowerShell. For development builds, Node.js 22+ and the prerequisites listed in the build scripts are needed.

1. Clone the repository and install the dependencies:

   ```powershell
   git clone https://github.com/shootingsyh/homemcp.git
   cd homemcp
   npm ci
   npm test
   ```

2. For a local **development-only** installation:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-dev.ps1
   ```

   The developer installation is distinct from the installed Windows Manager/MSI runtime. It is **not** a complete one-click public release.

3. If you have a separately built and tested MSI, install it and open **HomeMCP Manager** from the tray. The Windows Manager handles Start / Stop / Restart and local settings. See [Windows Manager](docs/manager.md) and [Windows release status](docs/msi-status.md). **Do not assume a public signed MSI download currently exists.**

4. Select **HomeMCP Managed** or **Bring Your Own Tunnel**. In BYOT, set up your HTTPS tunnel before binding the public origin. Confirm connectivity before registering devices.

### macOS (source / experimental)

**Requirements:** macOS, Node.js 22+, Xcode command-line tools with Swift compiler, and a browser compatible with the configured Playwright worker.

```sh
git clone https://github.com/shootingsyh/homemcp.git
cd homemcp
./scripts/macos/install.sh
```

The installer script installs dependencies, compiles the local Keychain helper and an **unsigned development SwiftUI Manager**, provisions a local-only host, and creates a user LaunchAgent. Configuration is retained at:

```text
~/Library/Application Support/HomeMCP/config.json
```

The SwiftUI Manager currently provides local restore, status, BYOT setup and Passkey QR entry points. macOS Managed FRP **is not yet fully activated end-to-end**; the desktop MCP worker is opt-in and initially exposes only read-only inspection tools. No notarized distributable package is available yet. See [macOS parity](docs/macos-feature-parity.md) and [upstream audit](docs/macos-upstream-audit.md).

## BYOT: bring your own domain and tunnel

BYOT is for people who already have **their own working HTTPS route** into their computer. It requires **no HomeMCP cloud API, enrollment or subscription**.

You provide:

- A public HTTPS origin, for example `https://mcp.example.com`. The TLS certificate must be valid for that name.
- A tunnel or proxy (Cloudflare Tunnel, your own FRP/reverse proxy, etc.) that forwards traffic securely to the **local HomeMCP Host**. Do not point it to an unrelated app.
- Control of DNS and the tunnel credentials. Those stay under your control.

### Example: Cloudflare Tunnel

This is an **illustrative** Cloudflare ingress configuration, **not** a copy-paste turnkey command. Replace the hostname and local Host port with your own values, and configure Cloudflare Tunnel credentials, DNS and access controls separately.

```yaml
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:YOUR_HOMEMCP_PORT
  - service: http_status:404
```

The local HomeMCP port is generated in `config.json`. Keep the Host bound to loopback. The public edge must validate HTTPS and preserve the intended Host header and path, including `/mcp` and `/.well-known/`.

**Important:** If your proxy/Cloudflare Access configuration intercepts or blocks OAuth discovery, authorization callbacks, the MCP endpoint, or Passkey pages, connecting an MCP client may fail. Do not disable HomeMCP OAuth/approval to work around that; configure the tunnel securely for the required routes.

### Verify before activating BYOT

HomeMCP's developing setup flow checks:

1. The URL has a valid public HTTPS hostname and DNS resolution.
2. TLS validation succeeds.
3. A short-lived random challenge from the local Host is returned **through the public tunnel**, proving it reaches this installation.
4. OAuth authorization-server metadata advertises the selected issuer.
5. Protected-resource metadata identifies `https://mcp.example.com/mcp`.

An arbitrary HTTP 200 or a CNAME alone is **not** sufficient. If verification fails, correct the tunnel/DNS/certificate and retry. The setup should not be marked complete.

**Windows:** Use the Manager's BYOT/public URL controls and validation flow. The first-run UX is still being hardened; [Windows Manager](docs/manager.md) describes the existing controls.

**macOS (experimental):** Start the local HomeMCP LaunchAgent first, then use the SwiftUI Manager's BYOT verification action or the underlying CLI:

```sh
node scripts/macos/setup.mjs status
node scripts/macos/setup.mjs byot https://mcp.example.com
```

A failed verification restores the prior local configuration. Mac-specific first-run and rollback behavior still requires real-device testing. Do **not** run an untested setup against a production system without a configuration backup.

### Connect ChatGPT or another MCP client

Once your public tunnel works and HomeMCP OAuth is configured:

1. Add a **remote MCP connector** in your MCP-capable client.
2. Enter your endpoint: `https://mcp.example.com/mcp` (for Managed, use the subdomain assigned to you plus `/mcp`).
3. Select **OAuth** authentication when supported.
4. The client should discover the HomeMCP OAuth metadata and open the authorization flow.
5. Complete Passkey registration/authorization using a trusted device, then invoke an innocuous read-only tool to verify connectivity.

Your client must actually support remote HTTP MCP and compatible OAuth flows. Exact connector creation menus vary by product and plan. OAuth compatibility and tool discovery have been tested in development, but individual client integrations may differ.

### Add a phone or other trusted device

On the Windows Manager choose **Set up Passkey (QR)**; macOS provides a corresponding **Set Up Passkey (QR)** action. Scan the code shown on the computer with a phone, or open the enrollment link locally. Follow the Passkey prompts.

The first device requires a trusted bootstrap; additional devices must be authorized through an existing trusted approval path. **Scanning a QR code is not permission to silently add devices.** Passkey credentials are bound to the selected HTTPS origin — changing domains can require new registration.

## Using HomeMCP

HomeMCP exposes tools according to your configured workers and policy. Available implementations include browser navigation/snapshots, Windows desktop operations, Passkey-protected approvals, and optional website credential handling. macOS computer-use functionality is not yet equivalent to Windows.

Tool policy is **allow / ask / deny**. Sensitive actions should require explicit Passkey approval. Approval pages are not access tokens and cannot substitute for OAuth authentication.

### Keep your installation safe

- Keep your OS, browser, HomeMCP and MCP clients updated.
- Never publish the local-only management interface directly.
- Keep static tokens, OAuth databases, Keychain/DPAPI records, enrollment credentials and TLS private keys secret. **Do not commit your installed `config.json` or data directory.**
- Treat a connected AI client as a powerful operator. Review sensitive actions before approving.
- Use separate test environments for changes to tunnel identities, certificates, billing, device registration and recovery.
- Do not enable arbitrary shell or unattended high-risk tools by default.

## Reinstalling and recovery

HomeMCP preserves existing local configuration when possible.

- **Reinstall on the same OS user profile:** preserved application data can restore the setup automatically. Encrypted tunnel credentials may be tied to that OS user.
- **Clean OS reinstall or new computer:** BYOT users reconfigure their own tunnel and device enrollment. Managed-domain Recovery Key-based reclaim **is planned but not implemented**. Do not delete the only copy of active enrollment credentials expecting automatic recovery.
- **Domain changes:** OAuth issuer and Passkey relying-party domain change; existing client authorizations may need to be redone.

## Development

```sh
npm ci
npm test
```

Project areas:

| Directory | Purpose |
|---|---|
| `src/` | Shared local MCP Host, OAuth, approvals, SQLite and worker clients |
| `web/` | OAuth/Passkey approval and enrollment pages |
| `native/Manager/` | Windows tray Manager |
| `native/macos/` | macOS SwiftUI Manager and Keychain helper |
| `scripts/` | Install, setup, certificates, tunnels and service lifecycle |
| `packaging/` | Windows MSI packaging scripts |
| `test/` | Unit and local integration tests |
| `docs/` | Design, security and release readiness notes |

For platform details see [architecture and safeguards](docs/design.md), [Windows release gates](docs/release.md), [macOS feature parity](docs/macos-feature-parity.md), and [managed/BYOT recovery boundaries](docs/connection-setup-recovery.md).

## Project status and open source

HomeMCP is **pre-release**. The Windows environment has been exercised in development; macOS is actively being brought to parity. Installer reliability, platform permissions, threat modeling, release signing, and clean-device E2E are still ongoing.

Contributions and bug reports can help once the repository is prepared for public collaboration. **Third-party notices, secret/history audit, security reporting instructions and reproducible release artifacts should be added before making the repository public.** The [MIT License](LICENSE) covers HomeMCP project code; it does not grant rights to third-party trademarks.
