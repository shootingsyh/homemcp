import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {McpClient} from '../src/core.mjs';

test('SSE matches string request ID and ignores unrelated events',async()=>{
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const id=JSON.parse(body).id;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(': heartbeat\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0",\ndata: "id":"'+id+'","result":{"ok":true}}\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const client=new McpClient('http://127.0.0.1:'+server.address().port+'/mcp',{write(){}});assert.deepEqual(await client.request('ping',{}),{ok:true})}
 finally{await new Promise(resolve=>server.close(resolve))}
});

test('unmatched tool call response is uncertain and never logged verbatim',async()=>{
 const events=[];
 const server=http.createServer(async(req,res)=>{
  for await(const chunk of req){} 
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('event: message\ndata: {"jsonrpc":"2.0","id":9999,"result":{"secret":"should-not-be-logged"}}\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const client=new McpClient('http://127.0.0.1:'+server.address().port+'/mcp',{write(...args){events.push(args)}});
  await assert.rejects(client.request('tools/call',{name:'browser_click'}),/upstream_execution_uncertain/);
  assert.ok(events.some(x=>x[1]==='upstream_response_unmatched'));
  assert.ok(!JSON.stringify(events).includes('should-not-be-logged'));
 }finally{await new Promise(resolve=>server.close(resolve))}
});
