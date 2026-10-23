import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('all launch paths use embedded bootstrap instead of old protected provision',()=>{
 const config=read('scripts/oracle-manager-config.mjs');
 const runner=read('scripts/oracle-run.mjs');
 const mac=read('scripts/macos/managed-setup.mjs');
 const agents=read('scripts/macos/write-managed-launchagents.mjs');
 const cli=read('scripts/oracle-tunnel.mjs');
 const ui=read('native/macos/Manager/HomeMCPManagerApp.swift');
 for(const content of [config,runner,mac,agents,cli]){
  assert.doesNotMatch(content,/loadSecret\(['"]frp-bootstrap['"]\)/);
 }
 assert.doesNotMatch(mac,/action==='bootstrap'/);
 assert.doesNotMatch(ui,/Save Bootstrap Token|FRP bootstrap token/);
 assert.match(config,/renderFrpcConfig/);
 assert.match(runner,/frpBootstrapToken/);
 assert.match(agents,/frpBootstrapToken/);
});
