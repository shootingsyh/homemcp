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

## October 16: lifecycle/update implementation

- `native/JobRunner`: Win32 Job Object process launcher, suspended worker creation, kill-on-job-close, parent-death watcher.
- Production launcher requires JobRunner, ensuring each spawned worker has a closeable containment lifetime.
- `scripts/update.ps1`: HTTPS manifest download, SHA-256 verification, pinned Authenticode publisher verification, and Windows Installer invocation.
- `scripts/configure-updater.ps1`: optional daily update check/install task for an explicitly configured signed feed.
- `scripts/remove-legacy-local.ps1`: scoped previous experimental MCP cleanup with `-WhatIf` support.

**Still not release-ready:** real Windows job-runner build and kill-tree tests, verified update rollback, an externally reachable *signed* update feed (repository is private), installer E2E and successful MSI artifact. Configuring a schedule alone does not activate unattended upgrades. Do not remove active production tools until smoke testing replacement.
