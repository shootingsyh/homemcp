import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('new browser tools are registered; file deletion cannot bypass approval',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-tools-test-'));
  const socket=net.createServer();
  const listenPort=await new Promise(resolve=>socket.listen(0,'127.0.0.1',()=>resolve(socket.address().port)));
  await new Promise(resolve=>socket.close(resolve));
  const config=path.join(directory,'config.json');
  const browserTools=['browser_click','browser_type','browser_press_key','browser_tabs'];
  fs.writeFileSync(config,JSON.stringify({port:listenPort,token:'test-token',dataDir:directory,workers:[],tools:Object.fromEntries(browserTools.map(name=>[name,{worker:'missing',upstream:name}]))}));
  const child=spawn(process.execPath,['src/server.mjs','--config',config],{cwd:process.cwd(),stdio:'ignore'});
  try{
    let ready=false;
    for(let n=0;n<50;n++){
      try{ready=(await fetch(`http://127.0.0.1:${listenPort}/health`)).ok;if(ready)break;}catch{}
      await delay(50);
    }
    assert.equal(ready,true);
    const rpc=async(method,params)=>{
      const response=await fetch(`http://127.0.0.1:${listenPort}/mcp`,{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      assert.equal(response.status,200);
      return response.json();
    };
    const listed=(await rpc('tools/list',{})).result.tools.map(x=>x.name);
    for(const name of [...browserTools,'file_delete','approval_resume'])assert.ok(listed.includes(name),`${name} missing`);
    const denied=await rpc('tools/call',{name:'file_delete',arguments:{path:'C:\\Windows\\system.ini'}});
    assert.ok(denied.error,'unapproved or out-of-home deletion must fail');
  }finally{
    child.kill('SIGTERM');await delay(100);
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
