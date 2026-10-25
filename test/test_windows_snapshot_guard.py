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
        self.names = {1:'WindowsMCPControl_0_top_abcd', 2:'Chrome_WidgetWin_1', 3:'TkTopLevel', 4:'Shell_TrayWnd', 5:'WindowsMCPFlash_abcd'}
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
    def test_destroyed_window_stops_retry_before_uia_error_logging(self):
        source=patcher.IMPORT+'''def capture(handle):
            for attempt in range(THREAD_MAX_RETRIES + 1):
                try:
                    get_nodes(handle)
                    break
                except Exception as e:
                    retry_counts[handle] = attempt + 1
                    get_window_name(handle)
'''
        result=patcher.transform(source,'tree')
        self.assertEqual(patcher.transform(result,'tree'),result)
        calls=[]
        scope={'THREAD_MAX_RETRIES':5,'retry_counts':{},'get_window_name':lambda h:calls.append('uia_logging')}
        def gone(handle):
            calls.append('capture')
            scope['is_internal_control_window']=lambda h:True
            raise RuntimeError('window destroyed')
        scope.update(is_internal_control_window=lambda h:False,get_nodes=gone)
        # The injected import is exercised separately using the generated GUARD.
        exec(result.replace(patcher.IMPORT,''),scope)
        scope['capture'](7)
        self.assertEqual(calls,['capture'])
        self.assertEqual(scope['retry_counts'],{})

if __name__ == '__main__':unittest.main()
