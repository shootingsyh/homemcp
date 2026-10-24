"""Patch the pinned windows-mcp dependency before packaging or worker restart.

Only skip Windows-MCP's own noninteractive overlay HWNDs, before entering UIA.
Other Python applications remain visible. Refuse unknown dependency layouts.
"""
from pathlib import Path
import ast
import sys

GUARD = '''import win32gui


def is_internal_control_window(handle):
    """Use Win32 only: querying UIA here could enter the blocked provider."""
    try:
        return win32gui.GetClassName(handle).startswith("WindowsMCPControl_")
    except Exception:
        # A destroyed HWND is not a valid capture target.
        return True
'''
IMPORT = 'from windows_mcp.homemcp_snapshot_guard import is_internal_control_window\n'


def transform(source, kind):
    if IMPORT.strip() in source:
        return source
    if kind == 'desktop':
        replacements = [
            ('                    win32gui.IsWindow(hwnd)\n',
             '                    not is_internal_control_window(hwnd)\n                    and win32gui.IsWindow(hwnd)\n'),
            ('            for depth, hwnd in enumerate(controls_handles):\n',
             '            for depth, hwnd in enumerate(controls_handles):\n                if is_internal_control_window(hwnd):\n                    continue\n'),
            ('        if not handle:\n            return None\n        return self.get_window_from_element_handle(handle)',
             '        if not handle or is_internal_control_window(handle):\n            return None\n        return self.get_window_from_element_handle(handle)'),
        ]
    else:
        replacements = [
            ('        for handle in windows_handles:\n',
             '        for handle in windows_handles:\n            if is_internal_control_window(handle):\n                continue\n'),
        ]
    for before, after in replacements:
        if source.count(before) != 1:
            raise RuntimeError(f'Unsupported windows-mcp {kind} layout: {before!r}')
        source = source.replace(before, after, 1)
    # Keep __future__ imports in their required position.
    tree = ast.parse(source)
    position = 0
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == '__future__':
            position = node.end_lineno
    lines = source.splitlines(keepends=True)
    lines.insert(position, IMPORT)
    result = ''.join(lines)
    ast.parse(result)
    return result


def apply(site_packages):
    root = Path(site_packages) / 'windows_mcp'
    targets = [(root / 'desktop/service.py', 'desktop'), (root / 'tree/service.py', 'tree')]
    changes = [(file, transform(file.read_text(encoding='utf-8'), kind)) for file, kind in targets]
    (root / 'homemcp_snapshot_guard.py').write_text(GUARD, encoding='utf-8')
    for file, content in changes:
        if file.read_text(encoding='utf-8') == content:
            continue
        backup = file.with_suffix('.py.before-homemcp-overlay-fix')
        if not backup.exists():
            backup.write_bytes(file.read_bytes())
        temp = file.with_suffix('.py.homemcp-tmp')
        temp.write_text(content, encoding='utf-8')
        temp.replace(file)
    print('Windows-MCP internal overlay exclusion installed')


if __name__ == '__main__':
    apply(sys.argv[1])
