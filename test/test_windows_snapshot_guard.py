import importlib.util
from pathlib import Path
import sys
import types
import unittest

spec = importlib.util.spec_from_file_location('patcher', Path(__file__).parents[1] / 'scripts/patch-windows-snapshot.py')
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

class SnapshotGuardTests(unittest.TestCase):
    def setUp(self):
        self.old = sys.modules.get('win32gui')
        self.names = {1:'WindowsMCPControl_0_top_abcd', 2:'Chrome_WidgetWin_1', 3:'TkTopLevel', 4:'Shell_TrayWnd'}
        sys.modules['win32gui'] = types.SimpleNamespace(GetClassName=lambda hwnd:self.names[hwnd])
        self.scope = {}
        exec(patcher.GUARD, self.scope)
    def tearDown(self):
        if self.old is None: sys.modules.pop('win32gui', None)
        else: sys.modules['win32gui'] = self.old
    def test_only_internal_overlays_are_excluded(self):
        self.assertEqual([h for h in self.names if not self.scope['is_internal_control_window'](h)], [2,3,4])
    def test_dead_hwnd_is_skipped(self):
        self.assertTrue(self.scope['is_internal_control_window'](99))
    def test_unknown_dependency_layout_fails_closed(self):
        with self.assertRaises(RuntimeError):patcher.transform('pass\n','desktop')
    def test_existing_patch_is_idempotent(self):
        source=patcher.IMPORT+'pass\n'
        self.assertEqual(patcher.transform(source,'desktop'),source)

if __name__ == '__main__':unittest.main()
