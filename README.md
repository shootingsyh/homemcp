# HomeMCP

**Bring your home computer to your favorite agent.**

HomeMCP connects the AI agent you already use to your own Windows PC or Mac. Let your agent work with your computer: organize files, run local programs, help develop software, inspect your desktop, and automate everyday tasks. Your programs run on your machine, with access controlled by HomeMCP's authentication and approval policies.

HomeMCP uses the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) and includes integrations tested with **ChatGPT and Muse**. Other agents can connect too, provided they support remote HTTP MCP and compatible authentication. Give your agent your **HomeMCP Host URL**; a capable MCP client can discover authentication metadata and available tools. Some clients require you to add the connection in their settings first.

> **Early preview.** Windows and macOS have been exercised on real machines, but installer, upgrade, recovery, and permission handling are still being improved. Read the release notes before installing. This is not a guarantee of unattended operation or security.

## What can your agent do?

- Find, sort, and organize files on your computer.
- Run local scripts, applications, and development tools.
- Help build and debug projects using your local environment.
- Inspect browser pages, screenshots, and desktop windows.
- Carry out workflows that combine an agent's reasoning with your computer's programs and resources.

Available tools depend on the platform, installed workers, OS permissions, and your allow / ask / deny policies. A connected agent can have substantial access to your computer; choose its permissions carefully.

## Get started

1. Download a Windows `.msi` or a macOS `.pkg` from [Releases](https://github.com/shootingsyh/homemcp/releases). Choose the correct architecture and read that release's limitations. Preview Mac packages may not be notarized.
2. Install and open **HomeMCP Manager**. Follow the setup flow and choose a connection method below.
3. Register a trusted device for Passkey authorization. Grant the OS permissions needed for the tools you want to use; macOS screen capture and desktop control require separate permissions.
4. Copy the **MCP URL** shown by Manager, such as `https://mcp.example.com/mcp`, into your agent's remote MCP connection settings. Choose OAuth where supported and complete authorization.
5. Try a simple read-only operation before asking the agent to change files or run programs.

**Release note:** the `0.1.34` preview packages predate the latest Windows Snapshot/indicator fixes and macOS Manager login-start fix. Those fixes are in [PR #7](https://github.com/shootingsyh/homemcp/pull/7) and [PR #8](https://github.com/shootingsyh/homemcp/pull/8); they are not yet included in those packages.

## Choose how to connect

### Recommended: Bring Your Own Tunnel

Use a domain and HTTPS tunnel that you control. **No HomeMCP subscription or hosted account is required for BYOT.** Your computer can stay behind your router without an inbound port-forwarding rule when using Cloudflare Tunnel.

New to domains and tunnels? Follow the [step-by-step Cloudflare guide](docs/cloudflare-setup.md): buy a domain, add it to Cloudflare, create a tunnel on the free plan, and connect it to HomeMCP. The domain itself usually has an annual cost; the guide distinguishes that from the tunnel.

### Prefer a managed connection? Subscription coming soon

HomeMCP Managed is intended to provide a HomeMCP subdomain and managed tunnel for people who prefer not to set up a domain and tunnel themselves. **Public subscription checkout is not available yet; production Stripe setup is still in progress.** Development enrollments are not proof that paid subscriptions are ready.

The planned subscription covers managed connectivity. Self-hosting with your own tunnel remains available without a HomeMCP tunnel subscription. Managed connectivity uses a HomeMCP domain; bring your own tunnel to use your own domain.

## Connect your favorite agent

**ChatGPT:** add a remote MCP app/connector using Manager's MCP URL and OAuth. Complete the browser authorization and trusted-device approval flow. Availability and menus depend on your ChatGPT account and client.

**Muse:** add HomeMCP as a remote MCP server using the same MCP URL and complete the supported authorization flow.

**Other agents:** provide the Host URL, for example `https://mcp.example.com`, or the full MCP endpoint `https://mcp.example.com/mcp`. HomeMCP publishes OAuth discovery metadata and an MCP tool list so compatible clients can discover how to connect and what they can do. A URL alone does not grant access, and clients without remote HTTP MCP or compatible OAuth support need their own integration.

You can tell a compatible agent:

> My HomeMCP host is https://mcp.example.com. Connect through its MCP endpoint, discover the available tools, and help me work with my home computer. Ask me to complete authorization when needed.

## Privacy and security disclaimer

**Making your home computer reachable from the Internet carries risk.** An authorized agent, a compromised client, a software bug, or a mistaken approval could expose private information or change your computer. HomeMCP includes safeguards, but **we cannot guarantee 100% security**. Use it only if you understand and accept the risks.

HomeMCP includes OAuth authentication, Passkey-based approval, per-tool allow / ask / deny policies, local state and audit records, and OS-backed credential protection where supported. These reduce risk; they do not eliminate it, and not every action requires a prompt under every policy.

**We do not inspect or store the contents of your MCP traffic on HomeMCP's managed servers.** The managed relay is designed to pass encrypted TLS traffic through to your own computer, rather than decrypting your instructions, files, screenshots, or tool results. Operating the service still requires account, subscription, and tunnel authentication information, and exposes connection metadata such as hostnames, addresses, timing, and traffic volume. This is not a promise that no metadata exists. See [Privacy](docs/privacy.md) and the [relay architecture](server/README.md).

With **BYOT**, your MCP traffic does not use the HomeMCP managed relay. Your agent provider and tunnel provider have their own data handling policies. In particular, a standard Cloudflare public HTTPS tunnel terminates public TLS at Cloudflare; do not treat it as an end-to-end encrypted path hidden from Cloudflare.

Keep your OS and HomeMCP updated, protect your trusted devices, and review sensitive actions. Never share tokens, enrollment links, installed configuration, or private keys. Disconnect the tunnel and revoke affected access if you suspect compromise. See [Security](SECURITY.md) for reporting vulnerabilities privately.

## Development

Requirements: Node.js 22 or later; native builds have additional platform prerequisites.

```sh
git clone https://github.com/shootingsyh/homemcp.git
cd homemcp
npm ci
npm test
```

| Directory | Purpose |
|---|---|
| `src/` | Local MCP host, authentication, policy, approvals, worker clients |
| `native/Manager/` | Windows Manager |
| `native/macos/` | macOS Manager and native helpers |
| `web/` | Authorization and trusted-device approval pages |
| `scripts/`, `packaging/` | Setup, lifecycle, builds, and installers |
| `server/` | Managed tunnel and account service |
| `docs/`, `test/` | Design notes and tests |

The default branch and preview release branches may differ. Check the release tag when reproducing a packaged build. Some older design documents describe earlier milestones; release notes describe the limitations of each distributed package. See the [publication status](docs/publication-status.md) for known test and dependency-audit findings.

## License

HomeMCP project code is open source under the [MIT License](LICENSE), provided **as is**, without warranty. Third-party components keep their own licenses. ChatGPT, Muse, Cloudflare, and other product names belong to their respective owners; compatibility does not imply endorsement.
