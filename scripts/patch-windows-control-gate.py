"""Scope Windows-MCP's ownership gate to tools that fight for the desktop.

Upstream 0.8.8 routes every MCP tool through ControlToolGate, so a user
touching their own keyboard or mouse blocks even PowerShell, FileSystem
and other background tools with USER_CONTROL. Only tools that inject
physical input or move foreground windows need the ownership lease;
the rest of the pinned tool set must keep working while the user is at
the desk. Unknown tools stay gated, matching upstream's conservative
default for unclassified tools.
"""
from pathlib import Path
import ast
import sys

HELPER = '''

# HomeMCP: only direct desktop input needs the ownership lease. Background
# tools (PowerShell, FileSystem, Process, ...) keep working while the user
# is at the keyboard; unclassified tools stay gated.
_HOMEMCP_DIRECT_DESKTOP_TOOLS = frozenset({
    "Click", "Type", "Scroll", "Move", "Shortcut", "MultiSelect", "MultiEdit",
})
_HOMEMCP_BACKGROUND_TOOLS = frozenset({
    "Clipboard", "ControlStatus", "DisplayInventory", "FileSystem",
    "Notification", "PowerShell", "Process", "Registry", "Scrape",
    "Screenshot", "Snapshot", "Wait", "WaitFor",
})
_HOMEMCP_APP_BACKGROUND_MODES = frozenset({"launch", "launch_executable"})


def _homemcp_requires_desktop_control(name, arguments=None):
    if name in _HOMEMCP_DIRECT_DESKTOP_TOOLS:
        return True
    if name == "App":
        mode = arguments.get("mode", "launch") if isinstance(arguments, dict) else "launch"
        return mode not in _HOMEMCP_APP_BACKGROUND_MODES
    if name in _HOMEMCP_BACKGROUND_TOOLS:
        return False
    return True
'''

LOGGER_ANCHOR = 'logger = logging.getLogger(__name__)\n'
GATE_ANCHOR = '''        if name == "ControlStatus":
            return await call_next(context)
'''
GATE_PATCHED = GATE_ANCHOR + '''        if not _homemcp_requires_desktop_control(
            name, getattr(context.message, "arguments", None)
        ):
            return await call_next(context)
'''


def transform(source):
    if '_homemcp_requires_desktop_control' in source:
        return source
    if source.count(LOGGER_ANCHOR) != 1 or source.count(GATE_ANCHOR) != 1:
        raise RuntimeError('Unsupported Windows-MCP control gate layout')
    source = source.replace(LOGGER_ANCHOR, LOGGER_ANCHOR + HELPER, 1)
    source = source.replace(GATE_ANCHOR, GATE_PATCHED, 1)
    ast.parse(source)
    return source


def apply(site_packages):
    file = Path(site_packages) / 'windows_mcp/tools/control_notifications.py'
    original = file.read_text(encoding='utf-8')
    fixed = transform(original)
    if fixed != original:
        backup = file.with_suffix('.py.before-homemcp-control-gate')
        if not backup.exists(): backup.write_bytes(file.read_bytes())
        temporary = file.with_suffix('.py.homemcp-tmp')
        temporary.write_text(fixed, encoding='utf-8')
        temporary.replace(file)
    print('Windows-MCP desktop control gate scoping installed')

if __name__ == '__main__': apply(sys.argv[1])
