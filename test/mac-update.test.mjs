import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validateSource,discover,download,digest,runUpdate,shellQuote} from '../scripts/macos/update.mjs';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'homemcp-update-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('remote updates require HTTPS and a trusted hash; local paths cannot inject commands',()=>{
 for(const source of [{},{pkg:'relative.pkg'},{url:'http://x',sha256:'a'.repeat(64)},{url:'https://x'},{url:'https://u:p@x',sha256:'a'.repeat(64)}])assert.throws(()=>validateSource(source));
 assert.equal(validateSource({pkg:"/tmp/it's a build.pkg"}).pkg,"/tmp/it's a build.pkg");
 assert.equal(shellQuote("a'b"),"'a'\\''b'");
});
test('discovery only selects HomeMCP packages and sorts newest first',async t=>{
 const dir=await temp(t);for(const name of ['HomeMCP-old.pkg','HomeMCP-new.pkg','unrelated.pkg'])await fs.writeFile(path.join(dir,name),'pkg');
 await fs.utimes(path.join(dir,'HomeMCP-old.pkg'),1,1);
 const result=await discover([dir,path.join(dir,'missing')]);assert.equal(result.length,2);assert.match(result[0].pkg,/new.pkg$/);
});
test('download rejects HTTPS downgrades and oversized streamed bodies',async t=>{
 const dir=await temp(t);
 await assert.rejects(download('https://x',path.join(dir,'a.pkg'),{fetcher:async()=>new Response(null,{status:302,headers:{location:'http://x/a'}})}),/Unsafe/);
 await assert.rejects(download('https://x',path.join(dir,'b.pkg'),{fetcher:async()=>new Response('123456'),maxBytes:3}),/too large/);
});
async function fixture(t){const dir=await temp(t),job=path.join(dir,'job'),pkg=path.join(dir,'input.pkg');await fs.mkdir(job);await fs.writeFile(pkg,'fixture-package');return {dir,job,pkg};}
test('hash mismatch prevents all installer commands and persists failure',async t=>{
 const {job,pkg}=await fixture(t);let commands=0;
 await assert.rejects(runUpdate(job,{pkg,sha256:'0'.repeat(64)},{platform:'darwin',command:async()=>{commands++;}}),/mismatch/);
 assert.equal(commands,0);assert.equal(JSON.parse(await fs.readFile(path.join(job,'status.json'))).phase,'failed');
});
async function mockInstaller(job,app,commands,{cancel=false,wrongID=false}={}) {
 return async (bin,args)=>{
  commands.push([bin,args]);
  if(bin.endsWith('pkgutil'))await fs.mkdir(path.join(job,'expanded','component','Payload','Applications','HomeMCP Manager.app'),{recursive:true});
  if(bin.endsWith('plutil'))return {stdout:args.includes('CFBundleIdentifier')?(wrongID?'other.app':'si.homemcp.manager'):'0.1.33',stderr:''};
  if(bin.endsWith('osascript')){if(cancel)throw Error('User canceled authorization');await fs.mkdir(path.join(app,'Contents/MacOS'),{recursive:true});await fs.writeFile(path.join(app,'Contents/MacOS/HomeMCP.Manager'),'new executable');}
  return {stdout:'installer: successful',stderr:''};
 };
}
test('successful update verifies payload, uses installer authorization, reopens Manager and checks Host',async t=>{
 const {dir,job,pkg}=await fixture(t),app=path.join(dir,'installed.app'),commands=[];
 const command=await mockInstaller(job,app,commands);
 assert.equal(await runUpdate(job,{pkg,sha256:await digest(pkg)},{platform:'darwin',command,appPath:app,health:async()=>true}),true);
 assert.equal(JSON.parse(await fs.readFile(path.join(job,'status.json'))).phase,'complete');
 assert.match(commands.find(([b])=>b.endsWith('osascript'))[1][1],/installer -pkg/);
 assert.ok(commands.find(([b])=>b.endsWith('codesign')));
 assert.ok(commands.find(([b])=>b.endsWith('open')));
 assert.equal(commands.some(([,a])=>a.some(x=>/gateway|frpc/.test(x))),false);
});
test('cancelled authorization never opens application or reports success',async t=>{
 const {dir,job,pkg}=await fixture(t),commands=[];const command=await mockInstaller(job,path.join(dir,'app'),commands,{cancel:true});
 await assert.rejects(runUpdate(job,{pkg},{platform:'darwin',command}),/canceled/);
 assert.equal(JSON.parse(await fs.readFile(path.join(job,'status.json'))).phase,'failed');
 assert.equal(commands.some(([b])=>b.endsWith('/open')),false);
});
test('wrong bundle is rejected before requesting administrator privileges',async t=>{
 const {dir,job,pkg}=await fixture(t),commands=[];const command=await mockInstaller(job,path.join(dir,'app'),commands,{wrongID:true});
 await assert.rejects(runUpdate(job,{pkg},{platform:'darwin',command}),/identifier/);
 assert.equal(commands.some(([b])=>b.endsWith('osascript')),false);
});
test('installed update with unhealthy Host reports needs_attention',async t=>{
 const {dir,job,pkg}=await fixture(t),app=path.join(dir,'app'),commands=[];
 await runUpdate(job,{pkg},{platform:'darwin',command:await mockInstaller(job,app,commands),appPath:app,health:async()=>false});
 assert.equal(JSON.parse(await fs.readFile(path.join(job,'status.json'))).phase,'needs_attention');
});
