# Bring your own domain and Cloudflare Tunnel

This guide connects your installed HomeMCP host to a stable public HTTPS hostname that you control. You do not need a HomeMCP subscription, an inbound router port, or a public home IP address.

You need a Windows PC or Mac running HomeMCP, a Cloudflare account, and a domain. Cloudflare Tunnel is available on the free plan for this setup, subject to Cloudflare's terms and limits. **Registering a domain is a separate, usually annual, cost.**

## 1. Buy a domain or use one you own

Create a [Cloudflare account](https://dash.cloudflare.com/). To buy a domain there, open Domain Registration / Register Domains, search for an available name, review both registration and renewal costs, and complete checkout. Verify your registrant email when asked. See Cloudflare's [domain registration guide](https://developers.cloudflare.com/registrar/get-started/register-domain/).

You can buy from another registrar instead. Add that domain as a site in Cloudflare, choose the Free plan for DNS, and change its authoritative nameservers at the registrar to the nameservers Cloudflare assigns. Wait until Cloudflare shows the domain as active. Preserve existing email and website DNS records; a nameserver change affects the whole domain. See [Cloudflare's domain setup instructions](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/).

Choose a dedicated subdomain, such as `mcp.example.com`. Replace that example throughout this guide. Do not reuse a hostname already serving another application.

## 2. Find your local HomeMCP address

Install HomeMCP, open Manager, and keep the local host running. Find the Host's HTTP `port` in your installed configuration. **Do not publish or paste the entire file: it contains credentials.**

Windows PowerShell, showing only the port:

```powershell
$homeMcpConfig = Get-Content -Raw "$env:LOCALAPPDATA\HomeMCP\config.json" | ConvertFrom-Json
$homeMcpConfig.port
```

macOS Terminal, showing only the port using Node.js:

```sh
node -e 'const fs=require("node:fs"),os=require("node:os"),p=require("node:path");console.log(JSON.parse(fs.readFileSync(p.join(os.homedir(),"Library/Application Support/HomeMCP/config.json"),"utf8")).port)'
```

If `node` is not on your PATH, use the bundled Node executable or the local address shown by your installed Manager. Do not install a second HomeMCP instance merely to read the port.

The tunnel destination will be `http://127.0.0.1:YOUR_PORT`, with `YOUR_PORT` replaced by that number. Keep the host bound to loopback. This is the local HTTP Host port, not the managed tunnel's TLS gateway port.

## 3. Create a tunnel

In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Networking → Tunnels** and create a tunnel named `homemcp`. In some dashboard layouts this is under Cloudflare One / Zero Trust → Networks → Connectors or Tunnels. Choose the **cloudflared** connector when offered.

Select your computer's operating system and architecture, then follow the dashboard's installation and run instructions **on the same computer as HomeMCP**. Use its service/background installation option so the tunnel can return after restart. Administrator authorization may be needed.

The command includes a tunnel token. Treat it as a secret: run it locally, do not commit it, and do not send it to your agent or post it in an issue. Do not start a second connector for an existing tunnel unless you intend to add a replica. Wait for Cloudflare to show the connector as **Healthy**.

See the current [official tunnel setup guide](https://developers.cloudflare.com/tunnel/get-started/) if dashboard labels have changed.

## 4. Publish the HomeMCP hostname

Select your tunnel, open **Routes → Add route → Published application** (called **Public Hostname** in some layouts), and configure:

| Setting | Value |
|---|---|
| Subdomain | `mcp` |
| Domain | Your domain, such as `example.com` |
| Path | Leave blank, to forward all required paths |
| Service type | HTTP |
| Service URL | `127.0.0.1:YOUR_PORT` |

Some layouts accept the full service URL `http://127.0.0.1:YOUR_PORT`. Let Cloudflare create the DNS record for the route. Resolve any conflicting DNS record deliberately; do not delete unrelated records.

Forward the hostname's paths without stripping or rewriting them. HomeMCP needs `/mcp`, `/.well-known/` OAuth discovery routes, authorization callbacks, and Passkey/enrollment pages. A route matching only `/mcp` is insufficient. Keep normal HTTPS certificate validation enabled.

Standard Cloudflare public tunnels terminate public TLS at Cloudflare and relay traffic through the connector. That is a different trust model from HomeMCP Managed's TLS passthrough relay; read [Privacy](privacy.md).

## 5. Bind and verify in HomeMCP

In HomeMCP Manager, choose **Bring Your Own Tunnel** and enter the public origin:

```text
https://mcp.example.com
```

Use the origin here, without `/mcp`. Run the connection verification offered by your Manager version. It must reach this particular installation through the tunnel and advertise the same public OAuth issuer and MCP resource. A working DNS record or generic HTTP 200 page is not enough.

For source-based macOS setups, the repository also provides:

```sh
node scripts/macos/setup.mjs byot https://mcp.example.com
```

Run that from the matching source checkout with the existing local Host running. Existing configured domains require an explicit migration; do not manually change only one URL field to force a rebind. Passkeys and OAuth authorizations are tied to the public origin.

Register your trusted phone or local device through Manager's enrollment flow, then grant the OS permissions you need.

## 6. Connect ChatGPT, Muse, or another agent

Copy the **MCP URL** shown in Manager:

```text
https://mcp.example.com/mcp
```

Add it as a remote HTTP MCP connection and select OAuth where supported. Complete authorization using your trusted device. Start with a harmless read-only request. Sharing the URL does not bypass authentication.

## Troubleshooting

- **502 / connector offline:** confirm the connector is Healthy, HomeMCP is running, and the route uses the current local Host port. If the port changed after a conflict, update the route.
- **OAuth discovery shows a login page or challenge:** an extra Cloudflare Access login, WAF challenge, or cache rule may be intercepting MCP or discovery. Configure it for your client's actual capabilities. Keep HomeMCP authentication enabled; do not solve this by allowing unauthenticated tools.
- **Wrong issuer / verification fails:** check the public origin, forwarding paths, and destination. Avoid caching MCP responses, OAuth metadata, or authorization pages.
- **Works until restart:** check both HomeMCP's startup registration and cloudflared's service. On macOS, desktop tools require a logged-in graphical session and the necessary permissions.
- **Random temporary hostname:** use a named tunnel and your stable domain. Changing hostnames changes OAuth and Passkey identity; temporary Quick Tunnel URLs are unsuitable for a persistent installation.

Stop or disable the tunnel route when you no longer want remote access. Protect your Cloudflare account with strong authentication, keep cloudflared updated, and rotate a leaked tunnel token.
