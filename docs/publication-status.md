# Public preview status — October 24, 2026

Opening the source does not mark a production release or enable paid subscriptions.

- **License:** MIT for project code. Third-party software retains its own licenses.
- **History scan:** Gitleaks 8.30.1 scanned all 324 commits reachable from the repository's advertised refs before this documentation change. Its three findings were reviewed: the intentionally public FRP bootstrap constant, a test fixture, and a prose false positive. No actual secret was identified by this scan. Automated scans cannot prove the absence of secrets or vulnerabilities.
- **Main-branch tests:** a fresh WSL installation ran 80 Node tests: 78 passed and two existing macOS adapter/signing fixtures failed. Corrected fixtures exist on the combined preview build branch; they have not been merged into main. This documentation change does not claim a clean main-branch test run.
- **Dependency audit:** `npm audit` reported one low and two high findings in the current dependency graph: `@simplewebauthn/server`, `acme-client`, and transitive `node-forge`. Audit severity is not an assessment of exploitability in this application. These findings remain unresolved; do not assume the public preview has cleared a security release gate. A forced major downgrade of the certificate client is not an appropriate unreviewed fix.
- **Packages:** the dual-platform `0.1.34` preview predates the latest Windows Snapshot/indicator fixes and Mac Manager login-start fix. See PRs #7 and #8. Full installer update/rollback and fresh-device validation remain incomplete.
- **macOS:** preview signing/notarization and permission handling remain development concerns. A successful login-start replay is not a completed physical reboot test.
- **Subscriptions:** production Stripe checkout is still being configured. Managed development enrollment does not mean public purchasing is available.

Please report ordinary bugs through Issues and security vulnerabilities through the private reporting route in [SECURITY.md](../SECURITY.md).
