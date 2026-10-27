import test from 'node:test';
import assert from 'node:assert/strict';
import {managedPlist,managedPaths} from '../scripts/macos/managed-launchagents.mjs';

test('managed macOS launchd plists use local binaries and never embed tunnel secrets',()=>{
 for(const mode of ['gateway','frpc']){
  const xml=managedPlist({
   mode,label:'si.homemcp.'+mode,node:'/opt/homebrew/bin/node',
   base:'/Users/demo/Library/Application Support/HomeMCP',
   log:'/Users/demo/Library/Logs/HomeMCP',
   helper:'/Applications/HomeMCP/keychain-helper',
   frpc:'/Applications/HomeMCP/frpc'
  });
  assert.ok(xml.includes('oracle-run.mjs'));
  assert.ok(xml.includes('<string>'+mode+'</string>'));
  assert.ok(xml.includes('HOMEMCP_MACOS_KEYCHAIN_HELPER'));
  assert.ok(xml.includes('HOMEMCP_HOME'));
  assert.ok(!xml.includes('Bearer'));
  assert.ok(!xml.includes('HOMEMCP_FRP_TENANT'));
 }
 assert.match(managedPaths('/Users/demo').gateway,/LaunchAgents[\\\/]si.homemcp.gateway.plist$/);
 assert.throws(()=>managedPlist({mode:'invalid'}),/unknown_managed_mode/);
});
test('plist escapes dynamic paths and labels',()=>{
 const xml=managedPlist({mode:'gateway',label:'x&<y>',node:'/path/"app"',base:'/a&b',log:'/log',helper:'/helper'});
 assert.ok(xml.includes('x&amp;&lt;y&gt;'));
 assert.ok(xml.includes('/a&amp;b'));
 assert.ok(xml.includes('&quot;app&quot;'));
});
