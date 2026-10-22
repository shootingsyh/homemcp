import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {ApprovalStore} from '../src/security.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('legacy and task-aware MCP clients interoperate; task only starts after approved',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-tasks-'));
 const socket=net.createServer();const port=await new Promise(r=>socket.listen(0,'127.0.0.1',()=>r(socket.address().port)));
 await new Promise(r=>socket.close(r));
 const config=path.join(dir,'config.json');
 fs.writeFileSync(config,JSON.stringify({port,token:'synthetic-token',dataDir:dir,workers:[],tools:{},security:{approvalTimeoutMs:600000}}));
 const child=spawn(process.execPath,['src/server.mjs','--config',config],{cwd:process.cwd(),stdio:'ignore'});
 try{
  let ready=false;
  for(let i=0;i<60;i++){try{ready=(await fetch('http://127.0.0.1:'+port+'/health')).ok;if(ready)break}catch{}await sleep(40)}
  assert.ok(ready);
  const rpc=async(method,params={})=>(await (await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{Authorization:'Bearer synthetic-token','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:17,method,params})})).json());
  const legacy=(await rpc('initialize',{protocolVersion:'2025-03-26'})).result;
  assert.equal(legacy.protocolVersion,'2025-03-26');assert.equal(legacy.capabilities.tasks,undefined);
  const newer=(await rpc('initialize',{protocolVersion:'2025-11-25'})).result;
  assert.equal(newer.protocolVersion,'2025-11-25');assert.ok(newer.capabilities.tasks.requests.tools.call);
  const t=(await rpc('tools/list')).result.tools.find(t=>t.name==='file_delete');
  assert.equal(t.execution.taskSupport,'optional');
  // Synthetic approved file_delete task: no actual file deletion is requested.
  const db=new ApprovalStore(dir);
  const pending=db.create('file_delete',{path:'synthetic-do-not-execute'},'Synthetic only');
  db.linkTask(pending.id);
  let state=(await rpc('tasks/get',{taskId:pending.id})).result;
  assert.equal(state.status,'working');assert.equal(state.taskId,pending.id);
  assert.equal((await rpc('tasks/get',{taskId:'00000000-0000-0000-0000-000000000000'})).error.code,-32602);
  assert.equal(db.claim(pending.id,pending.arguments_hash),null);
  assert.equal(db.complete(pending.id,'rejected'),'rejected');
  state=(await rpc('tasks/get',{taskId:pending.id})).result;assert.equal(state.status,'cancelled');
  const final=(await rpc('tasks/result',{taskId:pending.id})).result;
  assert.ok(Array.isArray(final.content));
  assert.equal(final.structuredContent.status,'rejected');
  assert.equal(final._meta['io.modelcontextprotocol/related-task'].taskId,pending.id);
  const second=db.create('file_delete',{path:'another-synthetic-path'},'Synthetic');
  db.linkTask(second.id);assert.equal(db.complete(second.id,'approved'),'approved');
  assert.ok(db.claim(second.id,second.arguments_hash));
  assert.ok(db.finish(second.id,{deleted:true}));
  assert.equal((await rpc('tasks/get',{taskId:second.id})).result.status,'completed');
  assert.equal((await rpc('tasks/result',{taskId:second.id})).result.structuredContent.result.deleted,true);
  db.shutdown();
 }finally{child.kill('SIGTERM');await sleep(120);fs.rmSync(dir,{recursive:true,force:true})}
});
