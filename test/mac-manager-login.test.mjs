import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {managerPlist,installManagerLogin,managerLabel} from '../scripts/macos/manager-launch-agent.mjs';
test('Manager login job opens the actual app once in Aqua, preserving explicit quit',()=>{
 const plist=managerPlist('/Applications/HomeMCP & "UI".app');
 assert.match(plist,/HomeMCP &amp; &quot;UI&quot;\.app/);
 assert.match(plist,/<string>\/usr\/bin\/open<\/string>/);
 assert.match(plist,/<key>RunAtLoad<\/key><true\/>/);
 assert.match(plist,/<key>KeepAlive<\/key><false\/>/);
 assert.match(plist,/<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
 assert.doesNotMatch(plist,/HomeMCP\.Desktop|desktop-worker|server\.mjs|frpc/);
 assert.throws(()=>managerPlist('relative.app'),/invalid_manager_app_path/);
});
test('Registration loads only the Manager login job and tolerates first-time bootout',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-login-'));
 const calls=[];
 try{
  const result=installManagerLogin({home,uid:501,run:(exe,args)=>{calls.push({exe,args});return {status:args[0]==='bootout'?3:0};}});
  assert.equal(result.enabled,true);
  assert.equal(fs.readFileSync(result.plist,'utf8'),managerPlist());
  assert.deepEqual(calls.map(c=>c.args[0]),['bootout','enable','bootstrap']);
  assert.equal(calls[1].args[1],'gui/501/'+managerLabel);
  assert.ok(calls.every(c=>c.exe==='/bin/launchctl'));
  assert.ok(calls.every(c=>c.args.join(' ').includes(managerLabel)));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('Failed bootstrap and root installation cannot report enabled',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-login-'));
 try{
  assert.throws(()=>installManagerLogin({home,uid:0}),/manager_requires_logged_in_user/);
  assert.throws(()=>installManagerLogin({home,uid:501,run:(exe,args)=>({status:args[0]==='bootstrap'?5:0})}),/manager_login_registration_failed/);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
