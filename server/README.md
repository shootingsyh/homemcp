# HomeMCP AWS Tunnel Server (single trusted tenant MVP)

This folder runs an **FRP HTTPS passthrough** server on a small AWS Lightsail or EC2 Linux host. It does NOT deploy anything automatically, change the existing Cloudflare Tunnel, or modify HomeMCP's MCP endpoints.

## Architecture

ChatGPT -> `https://homemcp.example.com/mcp` -> AWS TCP/FRP SNI routing (no TLS decryption) -> outbound frpc connection -> local HomeMCP **HTTPS** endpoint.

Cloudflare is **DNS only (grey cloud)**: an A record `homemcp.example.com` (or a wildcard A record) points to the AWS public IPv4 address. This is not Cloudflare Tunnel.

## AWS host setup

1. Create a Linux Lightsail/EC2 instance with a **static/public IPv4 address**, install Docker Engine and the Docker Compose plugin.
2. In its firewall/security group allow **TCP 443 and TCP 7000**. Keep SSH restricted to an administrator IP/key; do not expose other app ports.
3. Copy this `server/` folder onto the host. From the folder, run:

   ```sh
   cp .env.example .env
   chmod 600 .env
   # Replace FRP_TOKEN in .env with: openssl rand -hex 32
   docker compose config
   docker compose up -d
   docker compose ps
   ```

4. Configure Cloudflare DNS (grey cloud) to point `homemcp.example.com` at the instance public IP.

## Local HomeMCP client (manual pilot)

1. Install the corresponding frpc release (v0.68.0) on the local machine.
2. Copy `frpc.example.toml` into a local private file, set the AWS address, hostname, and matching token. Never commit this file with a real token.
3. Configure HomeMCP (or a local TLS terminator) to serve **HTTPS** on `127.0.0.1:8443`, with a **publicly trusted certificate for the requested hostname**. The TLS private key remains local. Existing HomeMCP instances that only serve HTTP cannot be forwarded directly by this HTTPS passthrough config.
4. Start `frpc -c frpc.toml`, then test from a separate machine:

   ```sh
   curl -v https://homemcp.example.com/mcp
   ```

An unauthorized/invalid-method response from the MCP application can be a valid connectivity signal; a certificate warning is not. Do **not** use `curl -k` as a production workaround.

## TLS certificates

The relay does not issue, install, or handle endpoint TLS certificates. This MVP **does not automate certificate issuance**. Use a valid certificate issued to your own hostname, installed only on the local HomeMCP TLS endpoint. For a machine behind NAT, ACME DNS-01 with a narrowly scoped Cloudflare DNS API credential is one option; keep that credential off the public relay and do not give arbitrary users zone-wide access. Plain TCP forwarding does not remove the client requirement to trust the endpoint certificate.

## Security boundaries and limitations

- This is a **single trusted tenant/pilot** configuration. FRP's shared server token authenticates clients but **does not enforce per-client hostname ownership**. Do NOT give this token to unrelated users; they could register/impersonate another user's hostname. Multi-tenant release requires scoped enrollment/authorization (for example an frps NewProxy authorization plugin) before any public rollout.
- TLS passthrough prevents the relay from trivially inspecting MCP HTTP headers/body, but a compromised relay can disrupt routing, capture metadata, and attempt active impersonation. Certificate trust/issuance must also be protected.
- The existing HomeMCP Bearer Token is separate from the FRP connection token and must stay local to the authorized MCP client; never put it in FRP server configuration or logs.
- Limit exposed capabilities on HomeMCP itself; a private tunnel does not replace application authentication.
- `443` is for public HTTPS; `7000` is FRP's inbound client control/data port. Never open an FRP dashboard publicly.
- Docker image is pinned to a version, not a digest; review upstream security fixes and update deliberately. AWS billing, DNS registration, and actual deployment are not performed here.

## Verification checklist

- `docker compose config` renders with a non-placeholder secret.
- `docker compose ps` shows frps running and the host is listening on ports 443/7000.
- frpc connects successfully using the same token and claimed hostname.
- HTTPS succeeds with a trusted certificate and MCP app responds through `/mcp`.
- Wrong token fails; disconnected client cannot serve the endpoint.
- A second unrelated client is **not** given the token (multi-tenant safety boundary).
