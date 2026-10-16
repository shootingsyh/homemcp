# Hyper-V test plan
No Docker. Use a clean Windows 11 guest with checkpoints and a dedicated test user.
Test: clean install without Node/Python; competing or outdated global dependencies; foreign occupied ports; worker crash, hang and restart without reboot; logon start; lock screen/logoff; upgrade rollback; uninstall; no stray child processes; low idle CPU; interrupted install and low disk; Playwright and Windows-MCP tool calls. Do not use production credentials or real payment accounts.
Production release gate: clean install -> login/start -> MCP ready -> kill individual worker and recover on next call -> stop -> upgrade -> restart/login -> ready -> uninstall. Collect worker logs, installer log, process tree and timing for each failure.
