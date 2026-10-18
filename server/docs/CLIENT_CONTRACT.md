# HomeMCP Client ↔ tunneld Contract (v1)

How the HomeMCP client integrates with the hosted tunnel service
(`tunneld`). There are no web pages and no public signup site:
registration happens entirely inside the client, payments happen on
Stripe's hosted pages, and credentials are delivered by this API.

Base URL: `https://api.homemcp.si` (all paths below are under it).
All request/response bodies are JSON. All timestamps are RFC 3339 UTC.

## Concepts

- **Username** — 3–30 chars, `[a-z0-9-]`, starts/ends alphanumeric, no
  `--`. It becomes the public hostname `<username>.tunnel.homemcp.si`.
  Chosen at enrollment; uniqueness includes pending enrollments.
- **Enrollment ID** — `enr_…`, 128-bit random, returned at enrollment
  creation. **It is a bearer capability**: anyone holding it can claim
  the account's credentials after payment. Keep it in client-local
  storage only; never log it, never put it in analytics/crash reports.
- **Per-user token** — the tenant credential (43-char base64url).
  Shown **exactly once**, at claim time. The server stores only its
  SHA-256 hash; it cannot be re-displayed. The client must persist it
  in its OS credential store and treat "lost token" as a
  contact-support flow.
- **Bootstrap token** — a shared frps token embedded in the HomeMCP
  app itself. Not user-specific, not a credential. The client fills it
  into the frpc config's `auth.token` (the claimed config contains the
  literal placeholder `BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP` where
  it goes).

## Subscription states (server vocabulary)

| `sub_status` | Meaning | Tunnel works? | Suggested client UI |
|---|---|---|---|
| `pending` | Enrollment exists; subscription not active yet | No | "Finish checkout to activate" |
| `trialing` | Annual plan in its 7-day free trial; card on file | Yes | "Free trial — first charge on {current_period_end}" |
| `active` | Paid and current | Yes | "Active" |
| `past_due` | Last payment failed; inside 3-day grace when `grace_until` is in the future | Yes, until `grace_until` | "Payment failed — update your card by {grace_until}" (countdown) |
| `canceled` | Subscription ended | No | "Subscription ended — resubscribe" |

Trial days left = `ceil((current_period_end − now) / 24h)` while
`trialing`. `current_period_end` for a trial is the trial end (first
charge date); for `active` it is the next renewal.

## Flow

### 1. Create enrollment

```
POST /api/v1/enrollments
{ "username": "alice", "plan": "annual" }        // plan: annual | monthly
```

- `201` → `{ enrollment_id, checkout_url, status: "pending_payment",
  username, plan, subdomain }`.
- Pricing semantics (enforced server-side via Stripe):
  - **annual** ($9.99/yr): Checkout collects a card **upfront** and
    starts a **7-day free trial**; the card is auto-charged when the
    trial ends.
  - **monthly** ($0.99/mo): no trial; the card is charged immediately.
- Persist `enrollment_id` locally, then open `checkout_url` in the
  system browser (normally a `checkout.stripe.com` URL; on internal
  mock-pay test servers it points at the server's own `/mock-pay/…`
  page instead — treat the URL as opaque either way, see
  [Mock Pay](#mock-pay-internal-testing)).

Errors: `422 invalid_username`, `422 username_reserved`,
`409 username_taken`, `422 invalid_plan`, `503 stripe_not_configured`,
`502 stripe_error`.

### 2. Wait for activation, then claim credentials

Poll (suggested: every 3s for the first minute after returning from
Checkout, then every 15s; stop on `claimed` or after ~10 minutes and
resume on app focus):

```
GET /api/v1/enrollments/{enrollment_id}
```

Responses by state:

- `pending_payment` — `{ status: "pending_payment", credentials_issued: false, … }`.
  The webhook has not landed yet (usually seconds). Keep polling.
- First response after payment — the server generates the token,
  stores only its hash, and returns it **once**:

```json
{
  "status": "claimed",
  "credentials_issued": true,
  "sub_status": "trialing",
  "credentials": {
    "username": "alice",
    "token": "…",
    "subdomain": "alice.tunnel.homemcp.si",
    "frpc_config": "…ready-to-write frpc.toml…"
  }
}
```

- Every later response — same shape **without** `credentials`. There
  is no way to fetch the token again.

Errors: `404 enrollment_not_found`.

Note: Stripe's success redirect lands the *browser* on this same GET
URL (it just renders JSON). The client must not depend on the redirect;
polling is the mechanism.

### 3. Run the tunnel

Write `credentials.frpc_config` to the client's frpc config location,
replacing the placeholder `BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP`
with the app-embedded bootstrap token, then start frpc. The config's
important properties (already set by the server):

- `user = <username>`, `metadatas.token = <per-user token>` — the
  plugin checks these on Login and on every proxy registration.
- One proxy: `type = "https"`, `customDomains = ["<username>.tunnel.homemcp.si"]`,
  local `127.0.0.1:8443`, which **must serve HTTPS with a publicly
  trusted certificate for the subdomain**. Any other proxy type or
  domain is rejected by the server with a reason string in frpc's log.
- A per-user bandwidth cap is applied by the server; frpc-side values
  are overwritten.

### 4. Account status

```
GET /api/v1/account
Authorization: Bearer <per-user token>
```

`200` → `{ username, subdomain, plan, sub_status,
current_period_end?, trial_end?, grace_until?, tunnel_allowed }`.
`trial_end` is present while `trialing` when the server knows it
(always for mock activations; for Stripe when the subscription reports
it) — for a trial, `current_period_end` is the same instant. Use it on
app start and on a slow timer to drive the subscription UI
(table above). `tunnel_allowed` is the server's own gate evaluation —
trust it over local inference.

Errors: `401 unauthorized`.

### 5. Manage billing (update card / cancel)

```
POST /api/v1/account/portal
Authorization: Bearer <per-user token>
```

`200` → `{ url }`: a Stripe Billing Portal session URL. Open it in
the system browser. Cancellations and card updates happen there; the
server learns about them via webhooks (state may lag a few seconds).

Errors: `401 unauthorized`, `409 no_billing_account`,
`503 stripe_not_configured`, `502 stripe_error`.

## Mock Pay (internal testing)

Internal/dev servers may run with mock pay enabled
(`TUNNELD_MOCK_PAY=1`, operator-side). **Production never does.** It
exists so this client flow can be built and tested before a real
Stripe account exists.

From the client's perspective, exactly one thing differs:

- The `checkout_url` returned by `POST /api/v1/enrollments` points at
  `{API_PUBLIC_BASE}/mock-pay/{enrollment_id}` instead of
  `checkout.stripe.com`. It is a plain HTML page (visually branded
  "MOCK PAY — internal test only, no real charge") with a single
  **Pay (mock)** button. Open it in the system browser exactly like a
  Stripe Checkout URL; never special-case its host or content.

Everything else is identical: the enrollment, poll/claim, account,
and state semantics are the same endpoints with the same shapes,
because the mock page activates the enrollment through the same
server-side funnel as the Stripe webhook. Plan behaviour matches too:
annual → `trialing` with `trial_end` = activation + 7 days (and
`trial_end` set in the account view); monthly → `active` immediately.

### Subscription-event test hook (operator/admin only)

To exercise the states real Stripe webhooks produce, an admin-key
holder (the server operator — not end users) can call:

```
POST /api/v1/mock/users/{username}/subscription-event
X-Admin-Key: <operator key>
{ "event": "invoice.payment_failed" }
```

| `event` | Resulting state |
|---|---|
| `trial.end` | `trialing` → `active` (stands in for the trial-conversion charge succeeding) |
| `invoice.paid` | → `active`, `grace_until` cleared |
| `invoice.payment_failed` | → `past_due`, `grace_until` = now + 3 days (tunnel keeps working until then; drive the "payment failed — update your card by {grace_until}" UI from it) |
| `subscription.deleted` | → `canceled` (the plugin rejects the user's frpc at its next login/proxy registration; `tunnel_allowed` becomes `false`) |

`200` → the resulting account view (same JSON as `GET /api/v1/account`).
Errors: `404` for the whole route when mock pay is disabled,
`401 unauthorized` without/with a wrong admin key,
`404 user_not_found`, `422 invalid_event`.

## Admin (operator only, not for clients)

```
GET /api/v1/admin/users
X-Admin-Key: <operator key>
```

Lists users with plan/status/Stripe IDs. Never returns token hashes.
`503 admin_disabled` when no key is configured server-side;
`401 unauthorized` on a wrong key.

## Error format

All errors are `{ "error": { "code": "<stable code>", "message": "<human text>" } }`.
Clients must key behaviour off `code`, not `message`.

Stable codes: `bad_request`, `invalid_username`, `username_reserved`,
`username_taken`, `invalid_plan`, `enrollment_not_found`,
`unauthorized`, `no_billing_account`, `stripe_not_configured`,
`stripe_error`, `admin_disabled`, `invalid_signature` (webhooks),
`user_not_found`, `invalid_event` (mock-pay test hook), `internal`.

## Security notes for client implementers

- Store the per-user token and the enrollment ID in the OS credential
  store / keychain, not in plain config files, and never in logs.
- The tunnel is zero-knowledge by construction (frps does SNI
  passthrough; TLS terminates at the home endpoint). Do not weaken it:
  the local endpoint's certificate must validate publicly, and the
  client must surface — never silently accept — certificate errors.
- The HomeMCP MCP-layer Bearer Token is unrelated to everything in
  this document and must not be sent to tunneld or frps.
