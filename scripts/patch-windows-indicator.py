"""Retain indicator DIBs across animation frames; preserve health/input gates."""
from pathlib import Path
import ast
import re
import sys

SURFACE = '''import ctypes
import threading
from windows_mcp.desktop import flash_overlay as api


class RetainedBitmap:
    """Owner-thread GDI surface: allocate/copy once, upload repeatedly."""
    def __init__(self, width, height, bgra):
        if width <= 0 or height <= 0 or len(bgra) != width * height * 4:
            raise ValueError("Invalid indicator bitmap")
        self.owner = threading.get_ident()
        self.width, self.height = width, height
        self.screen_dc = self.mem_dc = self.bitmap = self.old_bitmap = None
        try:
            self.screen_dc = api._user32.GetDC(None)
            if not self.screen_dc:
                raise OSError("GetDC failed")
            self.mem_dc = api._gdi32.CreateCompatibleDC(self.screen_dc)
            if not self.mem_dc:
                raise OSError("CreateCompatibleDC failed")
            info = api._BITMAPINFO()
            info.bmiHeader.biSize = ctypes.sizeof(api._BITMAPINFOHEADER)
            info.bmiHeader.biWidth = width
            info.bmiHeader.biHeight = -height
            info.bmiHeader.biPlanes = 1
            info.bmiHeader.biBitCount = 32
            info.bmiHeader.biCompression = api._BI_RGB
            bits = ctypes.c_void_p()
            self.bitmap = api._gdi32.CreateDIBSection(self.screen_dc, ctypes.byref(info), api._DIB_RGB_COLORS, ctypes.byref(bits), None, 0)
            if not self.bitmap or not bits.value:
                raise OSError("CreateDIBSection failed")
            ctypes.memmove(bits, bgra, len(bgra))
            self.old_bitmap = api._gdi32.SelectObject(self.mem_dc, self.bitmap)
            if not self.old_bitmap or self.old_bitmap == ctypes.c_void_p(-1).value:
                self.old_bitmap = None
                raise OSError("SelectObject failed")
        except BaseException:
            self.close()
            raise

    def draw(self, hwnd, x, y, opacity=255):
        if threading.get_ident() != self.owner:
            raise RuntimeError("Indicator surface belongs to another thread")
        if not self.bitmap:
            raise RuntimeError("Indicator surface is closed")
        pos = api._POINT(x, y)
        size = api._SIZE(self.width, self.height)
        origin = api._POINT(0, 0)
        blend = api._BLENDFUNCTION(api._AC_SRC_OVER, 0, opacity, api._AC_SRC_ALPHA)
        if not api._user32.UpdateLayeredWindow(hwnd, self.screen_dc, ctypes.byref(pos), ctypes.byref(size), self.mem_dc, ctypes.byref(origin), 0, ctypes.byref(blend), api._ULW_ALPHA):
            raise OSError("UpdateLayeredWindow failed")

    def close(self):
        if threading.get_ident() != self.owner:
            raise RuntimeError("Indicator surface belongs to another thread")
        if self.old_bitmap is not None:
            api._gdi32.SelectObject(self.mem_dc, self.old_bitmap)
            self.old_bitmap = None
        if self.bitmap:
            api._gdi32.DeleteObject(self.bitmap)
            self.bitmap = None
        if self.mem_dc:
            api._gdi32.DeleteDC(self.mem_dc)
            self.mem_dc = None
        if self.screen_dc:
            api._user32.ReleaseDC(None, self.screen_dc)
            self.screen_dc = None
'''
IMPORT = 'from windows_mcp.homemcp_indicator_bitmap import RetainedBitmap\n'

def transform(source):
    if IMPORT.strip() in source:
        return upgrade_owner_progress(upgrade_health_sample(source))
    replacements = [
        ('        self.opacity: int | None = None\n        try:\n            flash_overlay._push_bitmap(self.hwnd, x, y, width, height, bgra)',
         '        self.opacity: int | None = None\n        self._bitmap = None\n        try:\n            self._bitmap = RetainedBitmap(width, height, bgra)\n            self._bitmap.draw(self.hwnd, x, y)'),
        ('        flash_overlay._push_bitmap(\n            self.hwnd, self.x, self.y, self.width, self.height, self.bgra, opacity=opacity\n        )',
         '        self._bitmap.draw(self.hwnd, self.x, self.y, opacity=opacity)'),
        ('            self.hwnd = None\n\n\ndef _monitor_rects',
         '            self.hwnd = None\n        if self._bitmap is not None:\n            self._bitmap.close()\n            self._bitmap = None\n\n\ndef _monitor_rects'),
    ]
    for before, after in replacements:
        if source.count(before) != 1:
            raise RuntimeError('Unsupported windows-mcp indicator layout')
        source = source.replace(before, after, 1)
    tree = ast.parse(source)
    index = 0
    for item in tree.body:
        if isinstance(item, ast.ImportFrom) and item.module == '__future__':
            index = item.end_lineno
    lines = source.splitlines(keepends=True)
    lines.insert(index, IMPORT)
    result = upgrade_owner_progress(upgrade_health_sample(''.join(lines)))
    ast.parse(result)
    return result

def upgrade_owner_progress(source):
    # Liveness belongs to the owner thread, not to a fully completed multi-window
    # animation frame. Each successful native operation proves real progress;
    # a blocked individual call still leaves the one-second watchdog in force.
    tree = ast.parse(source)
    methods = [method for cls in tree.body if isinstance(cls, ast.ClassDef)
               for method in cls.body if isinstance(method, ast.FunctionDef) and method.name == '_run']
    if len(methods) != 1:
        raise RuntimeError('Unsupported indicator owner loop')
    method = methods[0]
    lines = source.splitlines(keepends=True)
    segment = lines[method.lineno - 1:method.end_lineno]
    output = [];sites = 0
    for index, line in enumerate(segment):
        output.append(line)
        match = re.match(r'^( +)(?:(?:layer|ring)\.(?:set_opacity|show|hide|move|close)|flash_overlay\._pump_messages)\(.*\)\n$', line)
        if match:
            sites += 1
            update = match.group(1) + 'self.heartbeat = time.monotonic()\n'
            if index + 1 >= len(segment) or segment[index + 1] != update:
                output.append(update)
    if sites < 4:
        raise RuntimeError('Unsupported indicator rendering operations')
    return ''.join(lines[:method.lineno - 1] + output + lines[method.end_lineno:])


def upgrade_health_sample(source):
    start = source.index('def is_healthy() -> bool:')
    end = source.index('\n\n@contextmanager', start)
    block = source[start:end]
    old = 'and 0 <= time.monotonic() - indicator.heartbeat <= 1.0'
    new = 'and 0 <= sampled_at - heartbeat <= 1.0'
    if new not in block:
        if block.count(old) != 1 or block.count('    return bool(') != 1:
            raise RuntimeError('Unsupported indicator heartbeat check')
        block = block.replace('    return bool(',
            '    # Read the shared heartbeat before sampling time: the owner can advance it.\n'
            '    heartbeat = indicator.heartbeat if indicator else 0.0\n'
            '    sampled_at = time.monotonic()\n'
            '    return bool(', 1).replace(old, new, 1)
    return source[:start] + block + source[end:]


def apply(site_packages):
    root = Path(site_packages) / 'windows_mcp'
    target = root / 'desktop/control_overlay.py'
    source = target.read_text(encoding='utf-8')
    updated = transform(source)
    helper = root / 'homemcp_indicator_bitmap.py'
    temp = helper.with_suffix('.py.homemcp-tmp')
    temp.write_text(SURFACE, encoding='utf-8');temp.replace(helper)
    if source != updated:
        backup = target.with_suffix('.py.before-homemcp-indicator-cache')
        if not backup.exists():backup.write_bytes(target.read_bytes())
        temp = target.with_suffix('.py.homemcp-tmp')
        temp.write_text(updated, encoding='utf-8');temp.replace(target)
    print('Windows-MCP indicator bitmap reuse installed')

if __name__ == '__main__':apply(sys.argv[1])
