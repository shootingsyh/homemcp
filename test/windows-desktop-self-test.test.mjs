import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopSelfTest,localClient} from '../scripts/windows-desktop-self-test.mjs';

function worker(call){return async (method,params)=>{
 if(method==='tools/list')return {tools:[{name:'desktop_Screenshot'},{name:'desktop_Snapshot'}]};
 if(method==='tools/call')return call(params.name);
 return {};
};}
test('both real actions must return content; report discards private data',async()=>{
 const calls=[];
 const report=await desktopSelfTest(worker(name=>{
  calls.push(name);return {content:name==='desktop_Screenshot'
   ?[{type:'image',data:'private-pixels'}]:[{type:'text',text:'private-window-title'}]};
 }));
 assert.equal(report.ready,true);
 assert.deepEqual(calls,['desktop_Screenshot','desktop_Snapshot']);
 assert.doesNotMatch(JSON.stringify(report),/private-/);
});
test('healthy Host and tool discovery do not mask a broken snapshot',async()=>{
 const report=await desktopSelfTest(worker(name=>name==='desktop_Screenshot'
  ?{content:[{type:'image',data:'pixels'}]}:{isError:true,content:[{type:'text',text:'private error'}]}));
 assert.equal(report.ready,false);assert.equal(report.checks[1].state,'failed');
 assert.doesNotMatch(JSON.stringify(report),/private error/);
});
test('pending approval is never treated as successful window content',async()=>{
 const report=await desktopSelfTest(worker(()=>({structuredContent:{approval_url:'https://private/approval'},content:[{type:'text',text:'pending'}]})));
 assert.equal(report.ready,false);assert.ok(report.checks.every(c=>c.detail==='approval_required'));
});
test('upstream plain-text capture error is not accepted as a window snapshot',async()=>{
 const report=await desktopSelfTest(worker(name=>name==='desktop_Screenshot'
  ?{content:[{type:'image',data:'pixels'}]}
  :{content:[{type:'text',text:'Error capturing desktop state: provider failed. Please try again.'}]}));
 assert.equal(report.ready,false);assert.equal(report.checks[1].detail,'desktop_call_failed');
});
test('timeouts stop additional requests to the same worker',async()=>{
 let calls=0;
 const report=await desktopSelfTest(worker(()=>{calls++;throw new DOMException('slow','TimeoutError');}));
 assert.equal(report.ready,false);assert.equal(calls,1);assert.equal(report.checks[1].state,'skipped');
});
test('local client authenticates only to loopback and carries its MCP session',async()=>{
 let calls=0;
 const client=localClient({port:3456,token:'local-secret'},async (url,options)=>{
  assert.equal(url,'http://127.0.0.1:3456/mcp');
  assert.equal(options.headers.Authorization,'Bearer local-secret');
  if(calls++)assert.equal(options.headers['Mcp-Session-Id'],'session-test');
  const {id}=JSON.parse(options.body);
  return new Response('data: '+JSON.stringify({jsonrpc:'2.0',id,result:{ok:true}})+'\n\n',
   {headers:{'content-type':'text/event-stream','mcp-session-id':'session-test'}});
 });
 assert.deepEqual(await client('initialize'),{ok:true});
 assert.deepEqual(await client('tools/list'),{ok:true});
 assert.throws(()=>localClient({port:'https://example.com',token:'secret'}),/local_configuration_missing/);
});
