# Security

HomeMCP is an early preview that can grant AI clients substantial access to a personal computer. Authentication, approval policies, and OS permissions reduce risk but cannot guarantee security.

## Report a vulnerability privately

Use the repository's [private vulnerability reporting form](https://github.com/shootingsyh/homemcp/security/advisories/new). Include the affected version, platform, impact, and a minimal reproduction with secrets removed. Please do not publish exploit details, active credentials, enrollment links, or unredacted logs in a public issue.

If private reporting is unavailable, open a public issue asking the maintainer for a private reporting channel without including the vulnerability details. There is no guaranteed response time or supported-version maintenance commitment during the preview.

## Reduce exposure

- Keep HomeMCP, your OS, tunnel connector, and agent clients updated.
- Enable only the workers and tool permissions you need. Review sensitive approvals.
- Keep the local Host bound to loopback; do not forward raw worker ports or separate management interfaces.
- Never disable OAuth or certificate validation as a connectivity workaround.
- Protect trusted devices and tokens. Do not commit installed configuration, databases, TLS private keys, or tunnel credentials.
- If access is compromised, disconnect the tunnel, revoke affected client/device access, and rotate affected credentials.

Managed relay account authentication depends on the per-user authorization plugin. The embedded shared FRP bootstrap constant is public and is **not** a per-user access credential; do not deploy the hosted relay with tenant authorization disabled.

See [Privacy](docs/privacy.md) for the traffic and metadata boundaries.
