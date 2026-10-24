# Windows staged updates

Manager's **Update HomeMCP…** window supports a trusted local MSI and the existing pinned-publisher HTTPS release feed. Daily automatic installation can be enabled through the same UI / configure-updater.ps1. Remote candidates require both the manifest SHA-256 and a valid pinned Authenticode signer. Local MSI selections are explicitly confirmed and hashed before launch. Jobs run from private copies of the PowerShell scripts outside the installed app and use an exclusive file lock.

Before stopping production:

1. Retain and validate a complete rollback MSI whose ProductCode matches the registered HomeMCP product. Select the full currently-installed MSI on the first update; a stripped Windows Installer cache file is not a substitute. Later updates retain last-good.msi. Signed automatic updates require a signed last-good installer too.
2. Check candidate UpgradeCode and a newer MSI version, and require its package.json version to agree.
3. Extract both candidate and rollback packages into separate directories.
4. Check required payload components, run Node syntax and worker CLI checks, and render the actual wizard/dashboard in isolated UI smoke mode.
5. Start the candidate Host on fresh loopback ports with fresh tokens, state and browser profile. Verify MCP initialize/tools-list and discover upstream browser/desktop tools without running desktop/browser actions. Repeat for the rollback payload.

Only then request the Manager's prepare-update handshake. Manager stops its owned processes and exits; no arbitrary node/python processes are killed. The updater waits for exit, snapshots config/network state/Passkey data, installs via Windows Installer and restarts Manager. It checks installed payload version and local Host health; workers may be stopped because HomeMCP starts them lazily. Failed new-version health removes the failed product where necessary, reinstalls the retained old MSI and restores the snapshot. A failed rollback becomes recovery_required rather than success. A timed-out/reboot-requiring installer stops automation behind recovery-required.lock to prevent competing installers.

Boundaries: candidate probes do not prove every tool action, public relay, OAuth login or screen interaction. An actual MSI cutover/rollback test on a disposable Windows installation is still required before using this as unattended production infrastructure. Production is not switched by the development tests. The installed bootstrap Manager must support prepare-update; older clients refuse safe cutover until that bootstrap is installed. Configuration snapshots may include secrets and remain private to the local user; do not publish job directories.

Tests: test/windows-update-transaction.ps1 executes the real orchestrator with scoped fake installer/health operations in a temporary directory. It covers preflight rejection, success, post-switch rollback, rollback failure, busy installer and wrong rollback product, plus hash/signer rejection. windows-update-probe.ps1 exercises real payload Host/worker discovery with isolated data. The existing WinForms UI smoke now renders the update window too.
