# macOS Manager updates (v1)

Open the HomeMCP menu bar menu → **Update HomeMCP…**. This window is available even when the Host or tunnel is unavailable, and before setup finishes.

- **Local build:** Find Local Build selects the newest `HomeMCP*.pkg` in `~/homemcp/build/macos-dist` or Downloads. Choose Package accepts a build at any other location. Build first with `HOMEMCP_CODESIGN_IDENTITY='HomeMCP Local Code Signing' sh scripts/macos/package.sh` on the signing Mac.
- **Remote build:** enter a directly downloadable HTTPS `.pkg` URL and its trusted SHA-256. HTTP and HTTPS-to-HTTP redirects are rejected. For private GitHub releases use a directly downloadable authorized link or download locally first. No tokens are stored in Manager settings. CI emits a `.pkg.sha256` alongside each release package.
- Confirm the selected build, then enter the macOS administrator password when requested. Builds must come from a trusted source: package scripts run as administrator. A bundle signature does not authenticate installer scripts; the trusted checksum covers the full remote package.

Manager stages a separate Node runtime and updater under `~/Library/Application Support/HomeMCP/updates/job-*`. This detached process continues if Manager, MCP, or the tunnel disconnects. It verifies the checksum (required remotely), expands the package, checks the HomeMCP application identifier and bundle signature, and invokes `/usr/sbin/installer` via the macOS administrator authorization dialog. It does not use remote-shell approvals or shut down the tunnel.

After installation it checks the installed bundle signature and version, reopens Manager and polls the configured local Host TCP port. `complete` means the installed version matches and the local Host is reachable. It does **not** certify public tunnel availability, OAuth, or desktop permissions. A local Host failure becomes `needs_attention`, with the installation outcome retained. Cancellation and validation failures become `failed`.

The update window reloads `latest.json` / `status.json` after Manager restarts. **Show Update Logs** opens the job directory (`installer.log`, staged package, source metadata and status). Jobs may contain a temporary signed download URL; their directory is private to the user. Builds, configuration, Passkeys and credentials are not deleted.

First installation of this updater still requires installing a package containing it. V1 does not rebuild source automatically, poll a release feed, install silently without administrator authorization, or roll back automatically. Keep the prior trusted installer for manual rollback. An updater crash can leave `active.lock`; confirm no updater/installer is running before removing that directory. Never start a competing installer while the first one is awaiting authorization.
