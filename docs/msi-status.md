# MSI delivery status

This is a **candidate build pipeline, not a tested production installer**. GitHub Actions (Windows) must successfully build and install the MSI before it is offered to end users.

Known blockers before one-click release:

- Hook up first-run provisioning (dynamic ports, protected per-user configuration, login autorun, stop/uninstall) to a transactional updater, rather than install custom actions with untracked side effects.
- Ship a correctly packaged Windows-MCP executable and verify its dependencies and tool list on a clean Windows VM.
- Lock all Node/Python dependencies and verify hashes; current Playwright version is a candidate, not validated.
- Verify Windows service / session agent lifecycle and no orphan worker processes, include Windows Job Objects.
- Implement download-signature-validation-update rollback. A GitHub Release is not an auto-updater by itself.
- Harden Passkey/HITL and audit before enabling remote ingress or arbitrary shell.

The build workflow deliberately uploads only after self-test. There is no public deployment in this stage.
