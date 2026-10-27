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
  Issued only by the claim POST (step 2); the server stores only its
  SHA-256 hash and can never re-display the same token. The claim is
  **recoverable until the client confirms (acks) that it persisted
  the credentials**: claiming again before the ack rotates the token
  and returns fresh credentials, so a crash or a failed save is fixed
  by simply claiming again. After the ack the token is final — the
  client must persist it in its OS credential store and treat "lost
  token" as a contact-support flow. (Mock test accounts are the
  exception — see Mock Pay: they can re-claim and self-delete.)
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
- **Operator-granted accounts:** if the operator has allowlisted the
  username server-side (named testers), the `201` instead carries
  `checkout_url: ""` and `status: "ready"` — payment was settled on
  the server and there is nothing to open. Skip the browser step and
  go straight to polling (step 2). The account view later reports
  `"mock": true` for such accounts.

Errors: `422 invalid_username`, `422 username_reserved`,
`409 username_taken`, `422 invalid_plan`, `503 stripe_not_configured`,
`502 stripe_error`.

### 2. Wait for activation, then claim credentials

**Poll the status** (suggested: every 3s for the first minute after
returning from Checkout, then every 15s; stop on `claimed` or after
~10 minutes and resume on app focus):

```
GET /api/v1/enrollments/{enrollment_id}
```

This GET is a **pure read**: it never issues, rotates or consumes
credentials, so polling/refreshing it any number of times is safe.
Response fields: `{ status, credentials_issued, claim_acked,
sub_status, … }` — never a `credentials` object.

- `pending_payment` — the webhook has not landed yet (usually
  seconds). Keep polling.
- `ready` — payment confirmed. Claim now.
- `claimed` — credentials were issued; `claim_acked` says whether
  the claim was confirmed (below).

**Claim** — an explicit POST, and the *only* issuance path:

```
POST /api/v1/enrollments/{enrollment_id}/claim
→ 200
{
  "status": "claimed",
  "credentials_issued": true,
  "claim_acked": false,
  "sub_status": "trialing",
  "credentials": {
    "username": "alice",
    "token": "…",
    "subdomain": "alice.tunnel.homemcp.si",
    "frpc_config": "…ready-to-write frpc.toml…"
  }
}
```

**Persist, then confirm.** Write the credentials to the OS
credential store / config *first*; only then:

```
POST /api/v1/enrollments/{enrollment_id}/claim/ack
{ "token": "…the token from the claim response…" }
→ 200 { "status": "claimed", "claim_acked": true, … }
```

Recovery semantics (the point of the ack):

- **Any failure before the ack** — app crash, network loss, save
  failure, lost response — just **claim again**. A claim on an
  un-acked enrollment **rotates** the token: the un-saved token dies
  and the response carries fresh credentials; persist those and ack
  with the new token. Concurrent claims converge the same way:
  exactly one token is live at any moment, so ack the newest one
  you saved.
- `409 stale_claim` (on ack) — a newer claim superseded the token
  you presented. Claim again, persist the newest credentials, ack
  again.
- **After a successful ack the claim is final.** Further claims get
  `409 already_claimed`; a lost token is a contact-support flow
  (operator reset). Acking again with the same token is idempotent
  (`200`).

Claim errors: `404 enrollment_not_found`,
`409 credentials_not_ready` (still `pending_payment` — keep
polling), `409 already_claimed`. Ack errors:
`404 enrollment_not_found`, `409 not_claimed` (claim first),
`409 stale_claim`, `400 bad_request` (missing token).

Note: Stripe's success/cancel redirects land the *browser* on a
static status page (`/checkout/complete`) that only tells the user
to return to the app — it carries no data and triggers nothing.
The client must not depend on the redirect; polling + claim is the
mechanism. (Contract history: issuance previously happened on the
status GET itself, which the Stripe redirect also hit — a browser
return could burn the one-time claim before the client saved it.
That behaviour is removed; clients must use the claim POST.)

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

### 6. Certificates via DNS-01 (per-user certificates)

Every user's endpoint `<username>.tunnel.homemcp.si` has its **own**
certificate. The client generates the key pair locally; **the private
key never leaves the user's machine and is never sent to the server —
there is no upload API, by design.** To prove domain control to the
ACME CA, the client must publish a DNS-01 TXT record at
`_acme-challenge.<username>.tunnel.homemcp.si`. Writing DNS is the
server's job (the DNS provider credential stays server-side), via
exactly these endpoints:

```
POST /api/v1/certificates/dns-challenges
Authorization: Bearer <per-user token>
{ "value": "<base64url SHA-256 digest of the key authorization>" }
```

The `value` is the 43-character digest your ACME library computes
from the key authorization; the server treats it as opaque and
publishes it verbatim. The record name is derived from your
authenticated username — the API has no field to name a record, so a
challenge can only ever be created for your own subdomain.

`201` → `{ id, name, value, status, created_at, expires_at }` with
`status: "pending"`.

```
GET    /api/v1/certificates/dns-challenges/{id}   (Bearer)
DELETE /api/v1/certificates/dns-challenges/{id}   (Bearer)
```

- `GET` → the same view. Status moves `pending` → `propagated` once
  the TXT is publicly resolvable (the server checks live DNS). Poll
  every ~10 s; propagation on this zone is typically under a minute.
  Only ask the CA to validate after `propagated`.
- `DELETE` → removes the TXT and returns the view with
  `status: "cleaned"`. Idempotent — call it as soon as validation
  finishes, success or failure, so challenge records never linger.
- Challenges live at most **2 hours**: past `expires_at` the server
  removes the TXT and reports `status: "expired"`. If your flow
  stalls past expiry, start over with a fresh challenge.
- Another user's challenge ID returns the same
  `404 challenge_not_found` as a nonexistent one.

Errors: `401 unauthorized`, `403 subscription_inactive` (issuance
requires `trialing`/`active`, or `past_due` inside its grace window),
`422 invalid_txt_value`, `429 challenge_limit` (more than 4 active
challenges), `429 challenge_rate_limited` (more than 10 created in
an hour), `502 dns_provider_error` (retry with backoff),
`503 cert_dns_not_configured` (operator has not enabled this yet).

Client requirements:

- Full flow: ACME order → get the DNS-01 digest → `POST` here →
  poll until `propagated` → tell the CA to validate → `DELETE` →
  install the issued certificate on the local endpoint.
- Certificates are per-user and issued by the CA directly to the
  client; the server never sees the certificate's private key and
  cannot re-issue or recover it. Losing the key is a purely local
  event: generate a new one and re-issue.
- Renewals repeat the identical flow with a fresh challenge
  (Let's Encrypt certificates last 90 days; renew with ~30 days
  remaining). Budget one challenge per issuance — the rate limits
  above are sized for that with ample headroom.

## Mock Pay (internal testing)

Mock payment is a **server-side** decision in two forms; the client
never declares itself paid — it enrolls and polls, and the server
decides what "paid" means for that username:

1. **Allowlist (any server, incl. production):** the operator names
   specific usernames. Their enrollments come back already `ready`
   with an empty `checkout_url` (see step 1) — nothing for the
   client to do differently beyond skipping the browser step.
2. **Global mock mode (internal/dev servers only,**
   `TUNNELD_MOCK_PAY=1` operator-side; production never enables it):
   every enrollment's `checkout_url` points at
   `{API_PUBLIC_BASE}/mock-pay/{enrollment_id}` instead of
   `checkout.stripe.com`. It is a plain HTML page (visually branded
   "MOCK PAY — internal test only, no real charge") with a single
   **Pay (mock)** button. Open it in the system browser exactly like
   a Stripe Checkout URL; never special-case its host or content.

Everything else is identical: the enrollment, poll/claim, account,
and state semantics are the same endpoints with the same shapes,
because mock activation goes through the same server-side funnel as
the Stripe webhook. Plan behaviour matches too: annual → `trialing`
with `trial_end` = activation + 7 days (and `trial_end` set in the
account view); monthly → `active` immediately. Mock accounts report
`"mock": true` in the account view.

### Test-account reuse and cleanup (mock accounts only)

Mock accounts exist to be reused, so they are exempt from the
claim-is-final-after-ack rule:

- **Re-claim:** claiming an already-claimed enrollment again (POST
  claim, as usual) returns **fresh credentials with a rotated
  token** (the previous token stops working immediately) — mock
  accounts may do this even after the ack. Client development can
  wipe local state and re-claim the same test username at will.
- **Self-delete:** `DELETE /api/v1/account` with the account's own
  Bearer token deletes the mock account completely — user,
  enrollments, DNS challenges (including provider-side TXT cleanup)
  — and the username can immediately be enrolled again from a clean
  slate. A real account calling it gets `409 not_mock_account`.
  The operator's allowlist entry is separate and survives deletion,
  so re-enrollment stays payment-free until the operator removes
  the name from the allowlist.

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
The hook serves an account when global mock mode is on, or when the
account is a mock (allowlist) account on any server; a real paying
account with mock mode off gets the same `404 user_not_found` as an
unknown user. Errors: `401 unauthorized` without/with a wrong admin
key, `404 user_not_found`, `422 invalid_event`.

## Admin (operator only, not for clients)

```
GET /api/v1/admin/users
X-Admin-Key: <operator key>
```

Lists users with plan/status/Stripe IDs and the `mock` flag. Never
returns token hashes. `503 admin_disabled` when no key is configured
server-side; `401 unauthorized` on a wrong key.

API ingress account: the public API hostname (`api.homemcp.si`) is
itself routed through frps by an operator-owned frpc account named
`api-ingress` (a reserved username, creatable only by the operator
directly in the store). The plugin confines that account to claiming
exactly the API hostname and confines every tenant to their own
subdomain, so the API host can never be squatted. Clients never
interact with this account; it is documented here only so the
hostname's routing is not a mystery.

Mock allowlist (see [Mock Pay](#mock-pay-internal-testing)):

```
GET    /api/v1/admin/mock-users
PUT    /api/v1/admin/mock-users/{username}     { "note": "…" } (optional)
DELETE /api/v1/admin/mock-users/{username}
X-Admin-Key: <operator key>
```

Credential recovery and test-account cleanup:

```
POST   /api/v1/admin/users/{username}/reset-credentials
DELETE /api/v1/admin/users/{username}
X-Admin-Key: <operator key>
```

`reset-credentials` rotates the user's token (the old one dies
immediately) and returns fresh `{username, token, subdomain,
frpc_config}` once, in the admin response — the recovery path for
hash-only storage, to be relayed to the user over a trusted channel.
The DELETE removes a **mock account only** (user, enrollments,
challenges, provider TXT records) so a test username starts over
clean; real accounts get `409 not_mock_account`. A mock account can
also delete **itself** — see
[Test-account reuse and cleanup](#test-account-reuse-and-cleanup-mock-accounts-only).

## Error format

All errors are `{ "error": { "code": "<stable code>", "message": "<human text>" } }`.
Clients must key behaviour off `code`, not `message`.

Stable codes: `bad_request`, `invalid_username`, `username_reserved`,
`username_taken`, `invalid_plan`, `enrollment_not_found`,
`credentials_not_ready`, `already_claimed`, `not_claimed`,
`stale_claim`,
`unauthorized`, `no_billing_account`, `stripe_not_configured`,
`stripe_error`, `admin_disabled`, `invalid_signature` (webhooks),
`user_not_found`, `invalid_event` (mock-pay test hook),
`not_mock_account`,
`cert_dns_not_configured`, `subscription_inactive`, `invalid_txt_value`,
`challenge_not_found`, `challenge_limit`, `challenge_rate_limited`,
`dns_provider_error`, `internal`.

## Security notes for client implementers

- Store the per-user token and the enrollment ID in the OS credential
  store / keychain, not in plain config files, and never in logs.
- The tunnel is zero-knowledge by construction (frps does SNI
  passthrough; TLS terminates at the home endpoint). Do not weaken it:
  the local endpoint's certificate must validate publicly, and the
  client must surface — never silently accept — certificate errors.
- The HomeMCP MCP-layer Bearer Token is unrelated to everything in
  this document and must not be sent to tunneld or frps.
- Your TLS private key is generated on your machine and must never be
  transmitted anywhere — the DNS-01 endpoints in step 6 exist
  precisely so it never has to be. Treat any request to "upload your
  key or certificate private part" as a red flag, not a feature.
