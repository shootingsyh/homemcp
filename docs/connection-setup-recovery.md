# HomeMCP connection setup and restore
Two supported connection modes, no custom-domain managed FRP hybrid:
- Managed (paid): HomeMCP subdomain + HomeMCP FRP + managed TLS. A domain belongs to a purchased enrollment, not a Windows installation.
- Bring Your Own Tunnel (free): user supplies HTTPS origin and manages DNS, routing and TLS. HomeMCP binds OAuth issuer and passkey RP domain to that origin.

## Local reinstallation
The MSI installs application binaries separately from user configuration at %LOCALAPPDATA%/HomeMCP. Provisioning preserves an existing config.json. Same-user DPAPI encrypted FRP credentials can be reused when present. A fully removed profile or OS reinstall cannot decode old DPAPI secrets.

## Managed domain recovery (not implemented)
Oracle API must add a recovery key enrollment grant; until then Windows Manager MUST NOT claim recovery works across wiped OS.
- At successful purchase/claim, generate one high-entropy recovery secret once; return it once for saving. Server stores only a verifier/hash with independent salt or keyed hash. Never persist plaintext or print it in logs.
- Recover endpoint accepts domain + recovery proof over HTTPS with strong rate limits, non-enumerating failures, and audit log. Recovery must be atomic: rotate enrollment/FRP tenant credentials, invalidate prior credentials, issue replacements bound to the new installation; preserve subscription/domain ownership.
- Design failure and concurrency semantics for two simultaneous recovery attempts; proof replay after successful recovery must fail, and issue a replacement recovery key.
- Expose a safe save-to-file option and user warning that a lost key cannot be recovered without another independently established recovery factor.
- Do not equate SMBIOS UUID, MachineGuid or local installation UUID with proof of ownership.
- Do not touch live production records when testing. Use isolated DB + mocked billing state and disposable domain.
