# Optional remote access setup

HomeMCP works locally without a Cloudflare account. Remote connectivity is optional.

## No Cloudflare account

1. Keep using HomeMCP on the same PC without setting up anything else.
2. For remote access, create a free Cloudflare account and add a domain/zone (a domain may cost money), then run the Windows PowerShell helper below.
3. Alternatively, configure your own trusted VPN/reverse proxy independently. The present HomeMCP server is loopback-only and remote access still requires a vetted proxy/authentication design.

## Cloudflare setup helper

Run from Windows PowerShell after HomeMCP has been installed and started at least once. Download the HomeMCP repository's `scripts/setup-cloudflare.ps1` file and, if needed, install cloudflared with the optional flag:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-cloudflare.ps1 -InstallCloudflared -TunnelName homemcp -Hostname mcp.example.com
```

If cloudflared and an existing tunnel are already configured on the machine:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-cloudflare.ps1 -ReuseExisting -TunnelName homemcp -Hostname mcp.example.com
```

The helper performs Cloudflare login when necessary, creates or locates a tunnel, configures the DNS record, and writes/validates an ingress config. **It intentionally does not run cloudflared, expose HomeMCP, change the HomeMCP security policy, or configure Cloudflare Access**. The remote deployment must not be enabled before authenticating the proxy, protecting the MCP token and confirming human approval behavior.

Do not start a second cloudflared for a tunnel already owned by another service. HomeMCP should only launch a dedicated managed tunnel when the implementation is verified.

## First-run MSI wizard

The MSI registers a per-user **RunOnce** command for the next Windows sign-in. It runs `scripts/network-setup.ps1`, which offers local-only access by default and optional networking:

- Detect configured Cloudflare hostnames from Windows and readable WSL `~/.cloudflared/config.yml` files.
- Select a detected existing hostname and tunnel without changing running processes, DNS, or ingress.
- Enter an HTTPS URL for Cloudflare or another tunnel/reverse proxy.
- Get account, domain and cloudflared installation guidance when Cloudflare is not installed.
- Save intent in `%LOCALAPPDATA%\\HomeMCP\\network-setup.json` (remoteEnabled remains false).

Existing ingress hostnames are **not a comprehensive enumeration** of Cloudflare DNS zones. Enumerating account-owned unused domains requires separate Cloudflare API authorization. The wizard does not assume that an existing hostname is available for reuse, and does not turn on remote access.

To run setup immediately after install or redo your choice:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\\HomeMCP\\app\\scripts\\network-setup.ps1" -Force
```

**Current limitation:** RunOnce launches on the next sign-in, not in the MSI UI. Remote integration and proxy/approval verification remain a separate development step.
