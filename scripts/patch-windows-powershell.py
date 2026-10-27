"""Avoid waiting for inherited PIPE EOF after a background launcher exits."""
from pathlib import Path
import ast
import sys

BEFORE = '''            result = run_with_graceful_timeout(
                args,
                stdin=subprocess.DEVNULL,  # Prevent child processes from inheriting the MCP pipe stdin
                capture_output=True,  # No errors='ignore' - let subprocess return bytes
                timeout=timeout,
                cwd=os.path.expanduser(path="~"),
                env=env,
            )
            # Handle both bytes and str output (subprocess behavior varies by environment)
            stdout = result.stdout
            stderr = result.stderr
'''
AFTER = '''            # A detached Start-Process child can inherit extra stdout/stderr
            # PIPE handles even when its own output is redirected. communicate()
            # then waits for the detached job to exit, after PowerShell is done.
            # File-backed capture waits for the shell, not inherited pipe EOF.
            with tempfile.TemporaryFile() as output_file, tempfile.TemporaryFile() as error_file:
                result = run_with_graceful_timeout(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=output_file,
                    stderr=error_file,
                    timeout=timeout,
                    cwd=os.path.expanduser(path="~"),
                    env=env,
                )
                output_file.seek(0)
                error_file.seek(0)
                stdout = output_file.read()
                stderr = error_file.read()
'''

def transform(source):
    if '# File-backed capture waits for the shell' in source:
        return source
    if source.count(BEFORE) != 1 or source.count('import subprocess\n') != 1:
        raise RuntimeError('Unsupported Windows-MCP PowerShell executor layout')
    source = source.replace('import subprocess\n', 'import subprocess\nimport tempfile\n', 1).replace(BEFORE, AFTER, 1)
    ast.parse(source)
    return source


def apply(site_packages):
    file = Path(site_packages) / 'windows_mcp/powershell/service.py'
    original = file.read_text(encoding='utf-8')
    fixed = transform(original)
    if fixed != original:
        backup = file.with_suffix('.py.before-homemcp-file-capture')
        if not backup.exists(): backup.write_bytes(file.read_bytes())
        temporary = file.with_suffix('.py.homemcp-tmp')
        temporary.write_text(fixed, encoding='utf-8')
        temporary.replace(file)
    print('Windows-MCP PowerShell file-backed capture installed')

if __name__ == '__main__':apply(sys.argv[1])
