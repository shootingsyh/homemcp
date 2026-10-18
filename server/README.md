# HomeMCP Tunnel Server (multi-tenant, zero-knowledge relay)

This folder runs the hosted HomeMCP tunnel service on a small Oracle
Cloud host (Always Free A1.Flex, Chicago): subscribers run frpc at home,
register through the HomeMCP client (no public signup pages), pay
$0.99/month or $9.99/year via Stripe, and get their own
`<username>.tunnel.homemcp.si` hostname routed to their machine.

It does NOT change the existing Cloudflare Tunnel path or HomeMCP's MCP
endpoints; it is an additional, self-hosted data path.

## Zero-knowledge architecture

The relay is built so that it **cannot read subscriber content**, even
though it routes it:

- **Data plane = TLS passthrough only.** frps listens on 443 with
  `vhostHTTPSPort` and routes connections by the TLS **SNI** hostname.
  It never terminates TLS for tenant domains, holds no tenant
  certificates, and cannot see HTTP headers or bodies. A subscriber's
  TLS session is terminated only at their own machine, where HomeMCP
  serves HTTPS on `127.0.0.1:8443` with a publicly trusted certificate
  for their own subdomain.
- **No plaintext surface exists to abuse.** `vhostHTTPPort` is never
  configured, the frps dashboard/webServer is never enabled, and no
  reverse proxy in front of frps touches tenant traffic.
- **Control plane = metadata only.** `tunneld` answers frps plugin
  calls (Login / NewProxy), the registration API, and Stripe webhooks.
  Plugin payloads contain usernames, proxy names, domain names and
  limits — never traffic. tunneld is not in the data path at all.
- **Credentials are hashed.** Per-user tunnel tokens exist in plaintext
  only in the one-time claim response and on the user's machine; the
  server stores SHA-256 hashes. Stripe card data never reaches this
  host (hosted Checkout + Billing Portal).
- **What the relay unavoidably sees:** SNI hostnames, connection
  timing, and byte counts (frps needs them to route and to enforce the
  per-user bandwidth cap). A compromised relay could disrupt routing or
  observe that metadata, and could attempt active impersonation —
  which is why tenant endpoints must present publicly trusted
  certificates and clients must never accept certificate warnings.

## Components

| Piece | Role |
|---|---|
| `frps` (fatedier/frps:v0.68.0) | Data plane: SNI passthrough on 443, frpc control on 7000 (`transport.tls.force = true`), bootstrap token auth. |
| `tunneld/` (Go, stdlib only) | Control plane: frp plugin (tenant auth, hostname isolation, bandwidth cap), registration/account API, Stripe webhooks, JSON user store. |
| Stripe | Hosted Checkout + Billing Portal + subscription webhooks. Card data stays with Stripe. |
| DNS | `tunnel.homemcp.si` and `*.tunnel.homemcp.si` as **DNS-only (grey cloud)** A records to the host — Cloudflare proxying cannot carry this raw TLS passthrough. |

### How tenant isolation works

1. frpc connects with the **shared bootstrap token** (`auth.token`) —
   frps verifies it (privilege key) before anything else. This token
   ships embedded in the HomeMCP app and is the same for everyone; on
   its own it grants nothing.
2. The **tunneld plugin** then runs on **Login**: frpc's `user` is the
   username and `metadatas.token` is the per-user token. The plugin
   checks the token hash and the subscription gate (trialing/active,
   or past_due inside the 3-day grace window).
3. On **NewProxy** the plugin re-checks identity and enforces:
   proxy type must be `https`; `customDomains` must be exactly
   `["<username>.tunnel.homemcp.si"]`; no `subdomain`/`remote_port`;
   and it rewrites `bandwidthLimit` to the per-user cap with
   server-side enforcement.
4. If tunneld is unreachable, frps **fails closed**: logins and proxy
   registrations are rejected.

### tunneld storage

One JSON file (`tunneld.json` on a named volume), rewritten atomically
on each mutation (temp file + fsync + rename), guarded by one mutex.
Chosen for this scale: one relay, hundreds of users, rare writes, zero
extra services to operate. Limits: single tunneld instance, O(n) writes.
If it ever outgrows that, swap `store.go` for SQLite behind the same
method set. Back up the volume like any other state file; it contains
token *hashes* and Stripe IDs, never plaintext tokens or card data.

## Pricing rules (encoded in tunneld + Stripe config)

- **Annual — $9.99/year.** 7-day free trial, but a card is collected
  upfront at Checkout (`payment_method_collection=always`,
  `trial_period_days=7`); Stripe charges automatically when the trial
  ends. Tunnel access works during the trial (`trialing` is allowed).
- **Monthly — $0.99/month.** No trial; charged immediately at checkout.
- **Failed payment:** status becomes `past_due`; access continues for
  a **3-day grace window**, then the plugin rejects logins/proxy
  registrations until an `invoice.paid` (or subscription update)
  restores `active`.
- **Cancel:** `customer.subscription.deleted` → `canceled` → access
  stops at the next login/proxy registration.

## Phase 1 (owner-only) can run frps alone

Before tunneld/Stripe are live, the relay works as a single-tenant
passthrough exactly like the original MVP: comment out the
`[[httpPlugins]]` block in `frps.toml`, run only the frps service, and
use one privately held frpc config with the shared token. Do **not**
hand that token to anyone else in this mode — without the plugin there
is no per-tenant hostname enforcement. Turn the plugin on (and keep it
on) before the first outside subscriber connects.

## Deploy outline (Oracle host)

1. Provision the A1.Flex host (1 OCPU / 6 GB, Ubuntu 24.04) with a
   reserved public IPv4. Firewall: allow **TCP 443** and **TCP 7000**
   from anywhere; SSH (22) restricted to the operator. Nothing else is
   published — tunneld's 7200 is never exposed (compose keeps it on the
   internal network, no `ports:`).
2. Install Docker Engine + Compose plugin. Copy this `server/` folder
   to the host.
3. `cp .env.example .env && chmod 600 .env`; fill `FRP_TOKEN`
   (`openssl rand -hex 32`) and, for multi-tenant, `TUNNELD_ADMIN_KEY`
   and the Stripe values. `docker compose config`, `docker compose up -d`,
   `docker compose ps` (tunneld must be healthy before frps serves
   logins, per the compose `depends_on`).
4. DNS (DNS-only / grey cloud): A records for `tunnel.homemcp.si` and
   `*.tunnel.homemcp.si` to the host IP.
5. API ingress: point `api.homemcp.si` at an operator reverse proxy on
   the host (e.g. Caddy) that forwards only `/api/*` and `/webhooks/*`
   to tunneld on the compose network (or map `127.0.0.1:7200` on the
   host for it). This proxy terminates TLS **only for the operator's
   own API hostname** — never for `*.tunnel.homemcp.si`, which stays
   frps passthrough. tunneld deliberately ships without published
   ports; how ingress reaches it is an operator choice at deploy time.
6. Stripe dashboard: create the two prices ($9.99/year, $0.99/month),
   put their IDs + the secret key in `.env`, and register the webhook
   endpoint `https://api.homemcp.si/webhooks/stripe` for
   `checkout.session.completed`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Put the signing secret in `.env`
   as `STRIPE_WEBHOOK_SECRET`.
7. Clients register from inside the HomeMCP app — see
   `docs/CLIENT_CONTRACT.md`.

## Security boundaries and limitations

- The **bootstrap token is not an authorization boundary** — it only
  proves "an official client". Authorization is per-user, in the
  plugin. Never log it, never put real values in git (`.env` only).
- The **enrollment ID is a bearer capability** for claiming
  credentials (see CLIENT_CONTRACT.md). It is 128-bit random and shown
  only in the creating client's session. Lost per-user tokens cannot
  be re-displayed (hash-only storage) — recovery is an operator reset
  (roadmap, not built yet).
- HomeMCP's own Bearer Token (MCP-layer auth) is a separate secret
  that stays between the MCP client and the home endpoint; it never
  transits or is stored by this relay — and thanks to passthrough, the
  relay could not read it even in transit.
- Pending enrollments reserve their username (anti-squatting);
  abandoned checkouts therefore need occasional operator cleanup.
- A private tunnel does not replace application authentication: keep
  HomeMCP's own auth enabled on every endpoint.
- Docker images are pinned by version tag, not digest; review upstream
  security fixes and update deliberately. DNS registration, Stripe
  account activation, and host provisioning are operator steps, not
  performed by anything in this folder.

## Verification checklist

- `docker compose config` renders; `docker compose ps` shows frps up
  and tunneld healthy.
- Owner frpc connects (plugin on) and `curl https://<user>.tunnel.homemcp.si/mcp`
  reaches HomeMCP with a valid, trusted certificate — no `curl -k`.
- Wrong per-user token → Login rejected; valid token + another user's
  domain in `customDomains` → NewProxy rejected; `type = "tcp"` →
  rejected.
- Stripe test mode: annual checkout asks for a card before the trial;
  webhook flips the user to `trialing`; claim returns credentials
  exactly once; monthly checkout charges immediately.
- Kill the subscription in Stripe test mode → after the next
  login/proxy registration, the tunnel refuses to connect.
- Nothing but 443/7000 is reachable from the internet
  (`nmap` the host); tunneld's 7200 answers only inside the compose
  network.
