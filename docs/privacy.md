# Privacy and data flow

HomeMCP runs tools on your own computer. Your agent provider receives the requests and tool results used in your agent session; review that provider's privacy policy as well as your tunnel provider's policies.

## Bring Your Own Tunnel

BYOT does not require a HomeMCP hosted account or subscription, and MCP traffic does not traverse the HomeMCP managed relay. You operate or choose the tunnel and DNS provider. A standard Cloudflare public HTTPS tunnel terminates public TLS at Cloudflare, so Cloudflare is part of your content trust boundary.

## HomeMCP Managed

The managed relay is designed to forward encrypted TLS streams to your computer without terminating the tenant's TLS connection. We do not inspect or store MCP payload contents on that relay, such as instructions, file contents, screenshots, or tool results. The local computer terminates TLS and runs the MCP tools. Keep certificate validation enabled.

This does **not** mean the service handles only a login name or has no metadata. Account and tunnel operations require account identifiers, credential verification data, domain/enrollment records, subscription state, and billing identifiers. The infrastructure can observe connection metadata, including network addresses, SNI hostnames, connection timing, and traffic volume; operational logs can contain account, registration, and connection events. Payment checkout, when production subscriptions launch, is handled through Stripe rather than collecting card details in HomeMCP.

See the [server architecture](../server/README.md) for the implemented separation between account/control operations and the encrypted traffic relay. Production subscription checkout is still being configured.

## Your computer

Configuration, OAuth state, approval records, credentials, and diagnostic logs are stored locally as required by the enabled features. OS-backed protection is used where supported; not every local record is encrypted. Logs and configuration can contain sensitive data. Protect your OS account and backups, and redact diagnostic files before sharing them.

An agent with tool access can read or modify information within its granted permissions. HomeMCP's access controls do not override your agent provider's handling of tool results, prevent all agent mistakes, or provide a guarantee against compromise. No security system can guarantee 100% safety.
