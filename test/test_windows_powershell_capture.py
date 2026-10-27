"""Run with the bundled Windows desktop Python after applying the patch."""
import os
from pathlib import Path
import tempfile
import time
import unittest
from windows_mcp.powershell.service import PowerShellExecutor

class PowerShellCaptureTests(unittest.TestCase):
    def test_short_command_output(self):
        result, code=PowerShellExecutor.execute_command("Write-Output 'CAPTURE_OK'",5)
        self.assertEqual(code,0); self.assertIn('CAPTURE_OK',result)
    def test_detached_child_does_not_hold_tool_response(self):
        import sys
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            child=root/'child.py'
            child.write_text('import time\ntime.sleep(8)\nprint("CHILD_DONE",flush=True)\n')
            out=root/'child.out';err=root/'child.err'
            quote=lambda s:"'"+str(s).replace("'","''")+"'"
            command=f'Start-Process -FilePath {quote(sys.executable)} -ArgumentList {quote(chr(34)+str(child)+chr(34))} -RedirectStandardOutput {quote(out)} -RedirectStandardError {quote(err)} -WindowStyle Hidden; "LAUNCH_SENT"'
            started=time.monotonic()
            result,code=PowerShellExecutor.execute_command(command,3)
            elapsed=time.monotonic()-started
            self.assertEqual(code,0,result);self.assertIn('LAUNCH_SENT',result);self.assertLess(elapsed,3)
            # Check the background job survives successful launcher completion.
            deadline=time.monotonic()+12
            while time.monotonic()<deadline:
                if out.exists() and 'CHILD_DONE' in out.read_text(errors='replace'):break
                time.sleep(.25)
            self.assertIn('CHILD_DONE',out.read_text(errors='replace'))
    def test_foreground_timeout_is_preserved(self):
        started=time.monotonic()
        result,code=PowerShellExecutor.execute_command('Start-Sleep -Seconds 8',1)
        self.assertEqual(code,1);self.assertIn('timed out',result);self.assertLess(time.monotonic()-started,7)

if __name__=='__main__':unittest.main(verbosity=2)
