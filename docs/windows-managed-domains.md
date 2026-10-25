# Windows managed setup and domain changes

Manager offers **Change domain…** on the dashboard and tray menu. Existing installations do not need to reset the setup wizard or remove devices.

- **Your own domain/tunnel:** configure the new HTTPS route, enter the new origin, and verify it. Manager restarts the connection and checks a local nonce through the public tunnel plus OAuth/resource discovery. Failed verification restores the previous configuration.
- **HomeMCP managed domain:** choose the new username/domain and monthly or annual plan. Manager resumes an existing local enrollment or creates one once, opens Stripe Checkout if payment is required, polls for activation, stores the one-time credentials with Windows DPAPI, obtains the domain's TLS certificate, and connects the installed Host and FRP gateway. The displayed connected state requires an actual nonce/issuer check.
- Changing domains may interrupt existing agent connections. Each domain has its own Passkey scope; existing records are retained, and switching back uses the original records. A new domain begins with no registered devices and the setup wizard guides enrollment if needed. The local device databases and user data are not deleted.
- Previously used managed domains retain protected credentials and certificates in a local domain cache. Reconnecting a cached domain does not create a new subscription or modify/delete the server account. Reinstallation/recovery still requires preserving local state.
- A failed or ambiguous registration POST is not retried automatically. Checkout is the only place that submits a payment. Closing the setup window stops polling; reopening the same domain resumes the pending enrollment rather than creating another Checkout session.

Validation: 106 Node tests on Windows (103 pass, three platform skips), a Windows .NET publish, and actual wizard/dashboard UI smoke checks. Domain-state tests cover retained Passkeys and OAuth records, original-device recovery, partial-write rollback, and registration resumption. Live Stripe payment and full cutover validation are tracked separately; passing these tests does not mean a real card was charged.
