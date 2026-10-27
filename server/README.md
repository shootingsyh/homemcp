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
  only in claim responses and on the user's machine; the
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
| `frps` (fatedier/frp release binary, v0.68.0) | Data plane: SNI passthrough on 443, frpc control on 7000 (`transport.tls.force = true`), bootstrap token auth. Runs as the `homemcp-frps` systemd unit — bare metal, no containers. |
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

One JSON file (`/var/lib/tunneld/tunneld.json`), rewritten atomically
on each mutation (temp file + fsync + rename), guarded by one mutex.
Chosen for this scale: one relay, hundreds of users, rare writes, zero
extra services to operate. Limits: single tunneld instance, O(n) writes.
If it ever outgrows that, swap `store.go` for SQLite behind the same
method set. Back up the file like any other state file; it contains
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

## Mock pay (server-side, two mechanisms)

Payment is always decided on the server — a client can only enroll
and poll; it can never assert "I paid". Two mock mechanisms exist:

### Per-username allowlist (named testers, production-safe)

The operator keeps a mock allowlist in the server store, managed with
the admin key:

```bash
curl -X PUT    $BASE/api/v1/admin/mock-users/<username> \
     -H "X-Admin-Key: $TUNNELD_ADMIN_KEY" -d '{"note":"friend tester"}'
curl           $BASE/api/v1/admin/mock-users -H "X-Admin-Key: $TUNNELD_ADMIN_KEY"
curl -X DELETE $BASE/api/v1/admin/mock-users/<username> -H "X-Admin-Key: $TUNNELD_ADMIN_KEY"
```

When a listed username enrolls, the server activates the enrollment
immediately — no Stripe call, no checkout page; the enrollment
response carries `checkout_url: ""` and `status: "ready"`, and the
client simply polls and claims. Add names **before** the person
enrolls (listing an existing username changes nothing for that
account). Plan semantics match the real checkout (annual → 7-day
`trialing`, monthly → `active`), activated accounts are permanently
flagged `"mock": true` in admin/account views and carry no Stripe
linkage (keep them out of revenue accounting), and every allowlist
activation is logged. Removing a name stops future no-payment
enrollments; an already-activated account stays active (cancel it
with the subscription-event hook below, which works for mock accounts
even when global mock mode is off).

### Global mock mode (internal testing only)

Setting `TUNNELD_MOCK_PAY=1` swaps Stripe for a built-in mock payment
provider so the HomeMCP client's registration flow can be developed
and tested before a real Stripe account exists:

- `POST /api/v1/enrollments` performs no Stripe call and returns
  `checkout_url = {API_PUBLIC_BASE}/mock-pay/<enrollment_id>`.
- The mock checkout page (one **Pay (mock)** button) activates the
  enrollment through the *same* activation funnel a
  `checkout.session.completed` webhook uses — annual starts the 7-day
  trial (`trial_end` recorded), monthly becomes `active` — so claim,
  account, and the plugin gate all run the production code path.
- An admin-only hook, `POST /api/v1/mock/users/<username>/subscription-event`
  (`X-Admin-Key`, body `{"event": …}`), drives the same state
  transitions as the Stripe webhooks: `invoice.paid`,
  `invoice.payment_failed` (past_due + 3-day grace),
  `subscription.deleted`, `trial.end`.
- With global mock mode off, the `/mock-pay/…` pages don't exist
  (plain 404s) and the event hook only serves mock accounts.
  tunneld logs a loud startup warning whenever mock mode is on.

> **⚠ NEVER enable global mock mode in production.** Anyone who
> obtains an enrollment link can open the mock page and activate that
> account **for free** — there is no card, no charge, no identity
> check. Run it only on internal/dev deployments (staging relay, LAN,
> localhost) for client development, and double-check
> `TUNNELD_MOCK_PAY` is unset (or `0`) before any public deployment.
> (The allowlist above is the production-safe mechanism: only the
> exact usernames the operator named can skip payment, and only via
> the admin key.)

## Standalone mock instance (for client development)

`deploy/run-mock.sh` + `.env.mock.example` package the mock mode
above as a ready-to-run instance the client developer can point the
HomeMCP client at while building the registration flow — no Oracle
host, no Stripe account, no real payment. It runs **tunneld only**:
frps is deliberately absent, because the enrollment → pay → claim →
account flow never touches the tunnel data plane. (The frpc config
handed out at claim time still names the production frps address; the
dev flow validates everything up to claim + account state, it just
does not open a real tunnel.)

Start it on any Linux host with Go available (it builds tunneld on
first run, or set `TUNNELD_BIN` to a prebuilt binary):

```bash
cp .env.mock.example .env.mock
# Edit .env.mock: set API_PUBLIC_BASE to the address the client dev
# machine will reach this host at (LAN IP or DNS name, port must
# match MOCK_PORT), and set TUNNELD_ADMIN_KEY
# (openssl rand -hex 32 — run-mock.sh refuses to start without it).
./deploy/run-mock.sh        # foreground; Ctrl-C to stop
```

What the client dev gets:

- **One base URL for everything.** The client uses `API_PUBLIC_BASE`
  (from `.env.mock`) as its API base. Enrollments created there
  return `checkout_url = <that same base>/mock-pay/<enrollment_id>`:
  API and mock checkout pages are the same tunneld on the same
  origin, exactly like production, where the checkout URL is on
  Stripe's origin instead.
- **Production-shaped API.** `POST /api/v1/enrollments`,
  `GET /api/v1/enrollments/<id>` (status polling only — reads never
  issue credentials), `POST /api/v1/enrollments/<id>/claim` +
  `…/claim/ack` (the recoverable claim protocol), `GET
  /api/v1/account`, and `POST
  /api/v1/account/portal` are the same endpoints with the same
  payloads as production (see `docs/CLIENT_CONTRACT.md`). On a mock
  instance the portal call answers `503 stripe_not_configured` —
  there is no Stripe customer behind a mock user — and subscription
  lifecycle is driven by the test hook instead.
- **The admin subscription-event hook.** With the `X-Admin-Key`
  header (value = `TUNNELD_ADMIN_KEY` from `.env.mock`),
  `POST /api/v1/mock/users/<username>/subscription-event` with
  `{"event": …}` simulates `invoice.paid`, `invoice.payment_failed`
  (past_due + 3-day grace), `subscription.deleted`, and `trial.end`,
  so the client can be exercised through every subscription state
  without waiting for real billing time to pass.

Smoke test (from any shell that can reach the instance):

```bash
BASE=http://192.168.1.50:7200   # = API_PUBLIC_BASE from .env.mock

# 1. Create an enrollment (annual -> starts as a 7-day trial).
curl -s -X POST "$BASE/api/v1/enrollments" \
  -H 'Content-Type: application/json' \
  -d '{"username":"devtester","plan":"annual"}'
# -> {"enrollment_id":"…","checkout_url":"http://192.168.1.50:7200/mock-pay/…","status":"pending_payment"}

# 2. "Pay": open the checkout_url in a browser and click
#    Pay (mock) — or POST it directly (no body needed):
curl -s -X POST "<checkout_url from step 1>" >/dev/null

# 3. Poll the enrollment until it reports "ready" (reads are pure
#    status; they never issue credentials), then CLAIM with an
#    explicit POST — the response carries
#    credentials{username, token, subdomain, frpc_config}:
curl -s "$BASE/api/v1/enrollments/<enrollment_id>"
curl -s -X POST "$BASE/api/v1/enrollments/<enrollment_id>/claim"

# 3b. Persist the credentials, THEN confirm the claim by acking
#     with the token. Until the ack, claiming again rotates the
#     token and re-issues (crash/save-failure recovery); after the
#     ack the claim is final:
curl -s -X POST "$BASE/api/v1/enrollments/<enrollment_id>/claim/ack" \
  -H 'Content-Type: application/json' -d '{"token":"<token from step 3>"}'

# 4. Account state with the claimed token:
curl -s "$BASE/api/v1/account" -H "Authorization: Bearer <token from step 3>"
# -> sub_status "trialing" (annual) with trial_end ~7 days out.

# 5. Drive lifecycle states with the admin hook:
curl -s -X POST "$BASE/api/v1/mock/users/devtester/subscription-event" \
  -H "X-Admin-Key: <TUNNELD_ADMIN_KEY from .env.mock>" \
  -H 'Content-Type: application/json' \
  -d '{"event":"invoice.payment_failed"}'   # -> past_due + 3-day grace
```

Stop it with Ctrl-C (it runs in the foreground). The mock user store
is `./tunneld-mock.json` next to this folder — delete it to start
clean.

> **⚠ Same warning as above, at the deployment level:** this profile
> exists so a client developer can self-serve test accounts — which
> is precisely why it must never be reachable as the production API.
> This same script is what will be deployed **for dev** on the
> Oracle host once it exists (client testing against a realistic
> host), as a separate instance next to — never instead of — the
> production relay installed by `deploy/install.sh`.

## Phase 1 (owner-only) can run frps alone

Before tunneld/Stripe are live, the relay works as a single-tenant
passthrough exactly like the original MVP: run
`PHASE1=1 ./deploy/install.sh`, which installs frps **without** the
`[[httpPlugins]]` block (equivalently: comment the block out of
`frps.toml` by hand), and use one privately held frpc config with the
shared token. Do **not** hand that token to anyone else in this mode
— without the plugin there is no per-tenant hostname enforcement.
Turn the plugin on (and keep it on) before the first outside
subscriber connects.

## Deploy outline (Oracle host)

**Bare metal only — no Docker.** frps is a single static binary and
tunneld is a single Go binary; each runs under its own systemd unit
(`deploy/install.sh` sets everything up):

1. Provision the A1.Flex host (1 OCPU / 6 GB, Ubuntu 24.04) with a
   reserved public IPv4. Firewall (VCN security list + host iptables,
   the latter handled by the installer): allow **TCP 443** and
   **TCP 7000** from anywhere; SSH (22) restricted to the operator.
   Nothing else is published — tunneld listens on loopback
   (127.0.0.1:7200) only.
2. Get this `server/` folder onto the host (clone the repo there, or
   copy the folder). `cp .env.example .env && chmod 600 .env`; fill
   `FRP_TOKEN` (`openssl rand -hex 32`), `TUNNELD_ADMIN_KEY`, and the
   Stripe values.
3. `sudo ./deploy/install.sh` — installs the frps release binary and
   builds tunneld (it fetches a Go toolchain if `go` is missing, or
   pass `TUNNELD_BIN=/path/to/tunneld`), writes `/etc/frp/frps.toml`,
   `/etc/frp/frps.env`, `/etc/tunneld/env`, and the two systemd
   units, then enables and starts them. Verify:
   `systemctl status homemcp-tunneld homemcp-frps` and
   `tunneld healthcheck`.
4. DNS (DNS-only): A records for `tunnel.homemcp.si`,
   `*.tunnel.homemcp.si`, and `api.homemcp.si` to the host IP.
5. API ingress: frps owns the public 443, so the API hostname gets
   its public entry *through frps itself*: an operator frpc account
   (`api-ingress`, a reserved username the plugin confines to exactly
   the API hostname) registers an https proxy for `api.homemcp.si`
   down to a local Caddy on `127.0.0.1:8444`, which terminates TLS
   **only for the operator's own API hostname** and forwards just
   `/api/*` and `/webhooks/*` to tunneld on `127.0.0.1:7200`
   (everything else, including `/plugin/frp`, is 404). Tenant
   domains stay pure passthrough. Run
   `sudo ./deploy/setup-api-ingress.sh` after `install.sh` (it seeds
   the ingress user, installs Caddy + both units, and drops a
   placeholder cert — swap in the real Let's Encrypt cert for the
   API host, obtainable via the same Cloudflare DNS-01 API token,
   and reload Caddy).
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
  be re-displayed (hash-only storage) — recovery is rotation via the
  operator endpoint `POST /api/v1/admin/users/{username}/reset-credentials`.
  Mock (test) accounts are deliberately reusable instead: re-claiming
  (POST claim) a claimed enrollment rotates and re-issues credentials
  even after the ack, and a mock
  account can delete itself with `DELETE /api/v1/account` (or be
  deleted by the operator) for a clean-slate re-enrollment.
- HomeMCP's own Bearer Token (MCP-layer auth) is a separate secret
  that stays between the MCP client and the home endpoint; it never
  transits or is stored by this relay — and thanks to passthrough, the
  relay could not read it even in transit.
- Pending enrollments reserve their username (anti-squatting);
  abandoned checkouts therefore need occasional operator cleanup.
- A private tunnel does not replace application authentication: keep
  HomeMCP's own auth enabled on every endpoint.
- Release binaries are pinned by version (`FRP_VERSION` in
  `deploy/install.sh`), not by hash; review upstream security fixes
  and update deliberately. DNS registration, Stripe account
  activation, and host provisioning are operator steps, not performed
  by anything in this folder.
- (History: the server originally shipped as Docker Compose files;
  those were removed when the deployment went bare-metal. They remain
  in git history on this branch if ever needed.)

## Verification checklist

- `systemctl is-active homemcp-frps homemcp-tunneld` → active;
  `tunneld healthcheck` passes; `ss -lntp` shows frps on 7000/443 and
  tunneld only on 127.0.0.1:7200.
- Owner frpc connects (plugin on) and `curl https://<user>.tunnel.homemcp.si/mcp`
  reaches HomeMCP with a valid, trusted certificate — no `curl -k`.
- Wrong per-user token → Login rejected; valid token + another user's
  domain in `customDomains` → NewProxy rejected; `type = "tcp"` →
  rejected.
- Stripe test mode: annual checkout asks for a card before the trial;
  webhook flips the user to `trialing`; the claim POST returns the
  credentials (a repeat claim before the ack rotates them; after the
  ack it is refused); monthly checkout charges immediately.
- Kill the subscription in Stripe test mode → after the next
  login/proxy registration, the tunnel refuses to connect.
- Nothing but 443/7000 is reachable from the internet
  (`nmap` the host); tunneld's 7200 answers only on loopback.
