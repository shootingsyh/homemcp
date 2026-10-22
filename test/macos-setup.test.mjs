import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {dataPath,savePublic,loadPublic} from '../src/tunnel-store.mjs';

const fixture=()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-macos-setup-'));
 const configPath=path.join(base,'config.json');
 const config={installationId:'test-install',port:23456,security:{adminToken:'test-only'},workers:[]};
 fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 const execute=(...args)=>spawnSync(process.execPath,['scripts/macos/setup.mjs',...args],{
  cwd:process.cwd(),env:{...process.env,HOMEMCP_HOME:base},encoding:'utf8',timeout:5000
 });
 return {base,config,configPath,execute,close:()=>fs.rmSync(base,{recursive:true,force:true})};
};
test('macOS setup reports retained config without showing secrets',()=>{
 const f=fixture();try{
  const result=f.execute('status');
  assert.equal(result.status,0);
  const parsed=JSON.parse(result.stdout);
  assert.equal(parsed.configured,false);
  assert.equal(parsed.mode,'local');
  assert.ok(!result.stdout.includes('test-only'));
 }finally{f.close()}
});
test('invalid BYOT origin is rejected before changing persisted identity',()=>{
 const f=fixture();try{
  const initial=fs.readFileSync(f.configPath,'utf8');
  for(const url of ['http://example.com','https://127.0.0.1','https://localhost','https://example.com/path','https://evil.example/?x=1']){
   const response=f.execute('byot',url);
   assert.notEqual(response.status,0);
   assert.match(response.stderr,/invalid_https_origin/);
   assert.equal(fs.readFileSync(f.configPath,'utf8'),initial);
  }
 }finally{f.close()}
});
test('public tunnel state follows explicit HOMEMCP_HOME, not default platform path',()=>{
 const prior=process.env.HOMEMCP_HOME;
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-macos-data-'));
 try{
  process.env.HOMEMCP_HOME=base;
  assert.equal(dataPath(),path.join(base,'data','oracle-tunnel'));
  savePublic('test-meta',{status:'ok'});
  assert.deepEqual(loadPublic('test-meta'),{status:'ok'});
  assert.equal(fs.statSync(path.join(dataPath(),'test-meta.json')).mode&0o777,0o600);
 }finally{
  if(prior===undefined)delete process.env.HOMEMCP_HOME;else process.env.HOMEMCP_HOME=prior;
  fs.rmSync(base,{recursive:true,force:true});
 }
});
