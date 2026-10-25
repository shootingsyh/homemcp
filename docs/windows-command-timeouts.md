# Windows PowerShell background launches

A PowerShell command may exit successfully while a Start-Process child inherits extra handles for its redirected stdout/stderr pipes. Waiting on subprocess.communicate() then waits for pipe EOF until the background child exits, even when that child's primary stdout/stderr were redirected to files.

Reproduced on the user's Windows machine: LAUNCH_SENT printed at ~0.22 seconds, PowerShell exit code was 0 at ~1.2 seconds, but pipe EOF arrived only after the 20-second background child exited. HomeMCP's 15-second upstream request deadline therefore expires on an already-completed launch. Detached training may still be running; never blindly retry the launch.

The packaged Windows-MCP PowerShell executor now captures output into temporary files. The existing foreground execution timeout waits for the shell process instead of inherited pipe EOF, then reads its completed output. File-backed handles also cannot indefinitely block a pipe reader waiting for background descendants. Temporary capture files have standard per-user temporary-file lifetime, including delete-on-close behavior on Windows. Foreground timeout cleanup remains unchanged.

Three real Windows tests cover short output, detached-child survival with early response, and foreground timeout. A real HomeMCP background launch of a 20-second dummy child returned promptly and the next PowerShell call succeeded while the child was still running. The user's training was not relaunched or terminated.

This patch does not remove the separate 15-second Host-to-worker request deadline. Foreground commands deliberately exceeding that limit still need asynchronous process/session support or coordinated deadline handling. It also does not provide the missing per-command request/PID audit records.

## Screenshot followed by Snapshot: flash-window race

A real isolated MCP worker reproduced Screenshot succeeding in about 0.5 seconds while the following Snapshot exceeded 7 seconds. faulthandler located the UIA lane in ControlFromHandle / IUIAutomation.ElementFromHandle. A Win32-only trace identified an own-process WindowsMCPFlash_* HWND entering the traversal, followed by repeated UIA lookups after that flash window had been destroyed. The existing exclusion covered WindowsMCPControl_* but missed screenshot flashes. Retrying a destroyed HWND and querying its UIA name in the error handler could exceed the Host's 15-second deadline.

The packaging patch now excludes both internal class prefixes before UIA and rechecks validity at each retry and before error-reporting UIA. It does not hide ordinary Python applications, disable flash/control indicators, change approval/input ownership, or increase timeouts. Five Python regression cases cover class filtering, dead handles, idempotent upgrades and no retry/error-name lookup after a window disappears.

Live validation after applying the patch and restarting only the desktop worker: local screenshot/window self-test passed; remote Snapshot returned successfully and a subsequent PowerShell hostname command succeeded. The running Host, relay and training processes were preserved. This follow-up patch is newer than the 0.1.34 development installers already published.
