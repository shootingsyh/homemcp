import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('existing macOS install gets tools without changing identity or explicit tool policies',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-upgrade-tools-'));
 try{
  const file=path.join(home,'config.json');
  const before={installationId:'existing',token:'unchanged',publicUrl:'https://devmac.tunnel.homemcp.si',security:{adminToken:'unchanged',policy:{shell_execute:'deny'}},workers:[{name:'browser',command:'node',args:[]}],tools:{browser_snapshot:{worker:'browser',upstream:'browser_snapshot'}}};
  fs.writeFileSync(file,JSON.stringify(before));
  const env={...process.env,HOMEMCP_HOME:home,HOMEMCP_TEST_MAC_TOOLS:'1'};
  const command=()=>spawnSync(process.execPath,['scripts/macos/upgrade-tools.mjs'],{cwd:process.cwd(),env,encoding:'utf8',timeout:5000});
  assert.equal(command().status,0);
  const after=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(after.installationId,'existing');
  assert.equal(after.token,'unchanged');
  assert.equal(after.security.adminToken,'unchanged');
  assert.equal(after.security.policy.shell_execute,'deny');
  assert.equal(after.security.policy.system_usage,'allow');
  assert.ok(after.tools.shell_execute&&after.tools.system_processes&&after.tools.browser_tabs);
  assert.equal(after.workers.filter(w=>w.name==='mac-system').length,1);
  assert.equal(command().status,0);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).workers.filter(w=>w.name==='mac-system').length,1);
 }finally{fs.rmSync(home,{force:true,recursive:true})}
});
