import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('manager monitors every five minutes and recovery is rate limited',()=>{
 const code=fs.readFileSync('native/Manager/Program.cs','utf8');
 assert.match(code,/Interval=300000/);
 assert.match(code,/hostFailures>=2/);
 assert.match(code,/bridgeFailures>=2/);
 assert.match(code,/TimeSpan\.FromMinutes\(15\)/);
 assert.match(code,/if\(monitoring\)return/);
});
test('bridge watch only repairs configured HomeMCP Windows bridge',()=>{
 const script=fs.readFileSync('scripts/bridge-watch.ps1','utf8');
 assert.match(script,/if\(!\$Repair\)\{exit 2\}/);
 assert.match(script,/protected-proxy\.mjs/);
 assert.match(script,/cloudflared\\config\.yml/);
 assert.match(script,/Get-NetTCPConnection/);
 assert.doesNotMatch(script,/Register-ScheduledTask|wsl\.exe|Restart-Computer/);
});
