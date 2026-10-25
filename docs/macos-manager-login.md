# Primary Manager at GUI login

Desktop IPC now lives in HomeMCP Manager, so starting only Host/gateway/frpc does not restore desktop tools after Manager exits. The old installer comments referred to a separate desktop SMAppService that is no longer registered.

activate-installed.sh now installs a user LaunchAgent named si.homemcp.manager. RunAtLoad opens /Applications/HomeMCP Manager.app through LaunchServices in the Aqua session, in the background. It is a one-shot launcher with KeepAlive=false: quitting Manager explicitly remains respected. launchctl therefore shows the launcher as not running with exit code 0 after successfully opening the persistent Manager app. No replacement capture helper or TCC reset is introduced, and Host/tunnel LaunchAgents remain independent.

The existing development Mac was repaired by registering the same LaunchAgent without changing the signed app. Validation: terminate only Manager, re-register/bootstrap the login job, observe a new Manager PID, permissions true, screenshot success and Finder window snapshot success. All 102 Node tests pass, including registration failures and root-user rejection. This simulates the login launch event; an actual future logout/reboot is still required to verify the full session transition. Published 0.1.34 packages predate this installer fix.
