import test from 'node:test';
import assert from 'node:assert/strict';
import {StdioMcpClient} from '../src/stdio-mcp.mjs';
import {Worker,Log} from '../src/core.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const fake=String.raw`let buffer='';process.stdin.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line)continue;const m=JSON.parse(line);if(m.id===undefined)continue;let result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:m.method==='tools/call'?{content:[{type:'text',text:JSON.stringify(m.params.arguments)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n')}});`;
test('stdio worker handshake, discovery and tool execution',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-stdio-'));
 const spec={name:'fake',transport:'stdio',command:process.execPath,args:['-e',fake]};
 const worker=new Worker(spec,new Log(dir));
 try {
  assert.equal((await worker.list())[0].name,'echo');
  const result=await worker.call('echo',{value:42});
  assert.equal(JSON.parse(result.content[0].text).value,42);
  assert.equal(worker.status,'ready');
 }finally{await worker.stop();fs.rmSync(dir,{recursive:true,force:true})}
});
test('stdio rejects exited child and cleans pending requests',async()=>{
 const client=new StdioMcpClient({command:process.execPath,args:['-e','process.exit(0)']},{timeoutMs:1000});
 await assert.rejects(()=>client.connect());await client.stop();
});
