import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
test('native Mac diagnostic worker speaks MCP and advertises three tools',async()=>{
 const child=spawn(process.execPath,['scripts/macos/diagnostics-worker.mjs'],{env:{...process.env,HOMEMCP_TEST_MAC_TOOLS:'1'},stdio:['pipe','pipe','pipe']});
 const iter=readline.createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const send=(id,method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
 try {
  send(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const init=JSON.parse((await iter.next()).value);
  assert.equal(init.id,1);
  send(2,'tools/list');
  const list=JSON.parse((await iter.next()).value);
  assert.deepEqual(list.result.tools.map(x=>x.name),['system_usage','system_processes','shell_execute']);
  send(3,'tools/call',{name:'system_usage',arguments:{}});
  const usage=JSON.parse((await iter.next()).value);
  assert.ok(usage.result.structuredContent.memory_total_bytes>0);
 }finally{child.kill('SIGTERM')}
});
