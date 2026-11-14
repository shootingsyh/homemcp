import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('patcher', Path(__file__).parents[1] / 'scripts/patch-windows-control-gate.py')
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

FIXTURE = '''import logging

logger = logging.getLogger(__name__)


class ControlToolGate:
    async def on_call_tool(self, context, call_next):
        self.notifier.remember(context)
        name = context.message.name
        if name == "ControlStatus":
            return await call_next(context)
        return await self._gated(context, call_next)
'''


class ControlGatePatchTests(unittest.TestCase):
    def test_bypass_inserted_after_control_status(self):
        result = patcher.transform(FIXTURE)
        self.assertIn('def _homemcp_requires_desktop_control(', result)
        status_at = result.index('if name == "ControlStatus":')
        bypass_at = result.index('if not _homemcp_requires_desktop_control(')
        gated_at = result.index('return await self._gated(context, call_next)')
        self.assertLess(status_at, bypass_at)
        self.assertLess(bypass_at, gated_at)

    def test_classification(self):
        scope = {}
        exec(patcher.HELPER, scope)
        requires = scope['_homemcp_requires_desktop_control']
        for name in ['Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'MultiSelect', 'MultiEdit']:
            self.assertTrue(requires(name), name)
        for name in ['PowerShell', 'FileSystem', 'Registry', 'Snapshot', 'Screenshot',
                     'Scrape', 'Wait', 'WaitFor', 'DisplayInventory', 'Notification',
                     'Process', 'Clipboard', 'ControlStatus']:
            self.assertFalse(requires(name), name)
        self.assertFalse(requires('App'))
        self.assertFalse(requires('App', {'mode': 'launch'}))
        self.assertFalse(requires('App', {'mode': 'launch_executable'}))
        self.assertTrue(requires('App', {'mode': 'resize'}))
        self.assertTrue(requires('App', {'mode': 'switch'}))
        self.assertTrue(requires('App', {'mode': 'unknown-mode'}))
        self.assertTrue(requires('SomeFutureTool'))

    def test_unknown_dependency_layout_fails_closed(self):
        with self.assertRaises(RuntimeError):
            patcher.transform('pass\n')

    def test_existing_patch_is_idempotent(self):
        once = patcher.transform(FIXTURE)
        self.assertEqual(patcher.transform(once), once)


if __name__ == '__main__':
    unittest.main()
