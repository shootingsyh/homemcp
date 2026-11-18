import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {HomeOAuth} from '../src/oauth.mjs';
const wait=x=>new Promise(r=>setTimeout(r,x));
const freePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
test('OAuth discovery, 401 challenge and legacy / OAuth MCP credentials',async()=>{const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-oauth-http-')),port=await freePort(),config=path.join(tmp,'config.json');fs.writeFileSync(config,JSON.stringify({port,dataDir:tmp,host:'127.0.0.1',token:'legacy-secret',security:{rpOrigin:'https://mcp.example.org',rpID:'mcp.example.org'},workers:[],tools:{}}));const child=spawn(process.execPath,['src/server.mjs','--config',config],{cwd:process.cwd(),stdio:'ignore'});const root=`http://127.0.0.1:${port}`;try{let ready=false;for(let i=0;i<40;i++){try{ready=(await fetch(root+'/health')).ok;if(ready)break}catch{}await wait(100)}assert.ok(ready,'Host ready');const meta=await (await fetch(root+'/.well-known/oauth-authorization-server')).json();assert.equal(meta.issuer,'https://mcp.example.org');assert.equal(meta.scopes_supported.includes('offline_access'),true);const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}),post=key=>fetch(root+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},body});const denied=await post();assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/oauth-protected-resource/);assert.equal((await post('legacy-secret')).status,200);const auth=new HomeOAuth(tmp,'https://mcp.example.org');const access=auth.issueTokens('test-client',auth.resource,'mcp').access_token;auth.close();assert.equal((await post(access)).status,200);assert.equal((await post('bad-token')).status,401)}finally{child.kill('SIGTERM');await wait(300);fs.rmSync(tmp,{recursive:true,force:true})}});

test('OAuth audit records outcomes without exposing credentials',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-oauth-audit-')),port=await freePort(),config=path.join(tmp,'config.json');
 const clientId='test-client-id-not-for-logs',secret='secret-token-not-for-logs';
 fs.writeFileSync(config,JSON.stringify({port,dataDir:tmp,host:'127.0.0.1',token:'legacy-secret',security:{rpOrigin:'https://mcp.example.org',rpID:'mcp.example.org'},workers:[],tools:{}}));
 const child=spawn(process.execPath,['src/server.mjs','--config',config],{cwd:process.cwd(),stdio:'ignore'}),root='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<40;i++){try{ready=(await fetch(root+'/health')).ok;if(ready)break}catch{}await wait(100)}
  assert.ok(ready);
  const auth=new HomeOAuth(tmp,'https://mcp.example.org');
  const tokens=auth.issueTokens(clientId,auth.resource,'mcp offline_access');auth.close();
  const post=(p,b,h)=>fetch(root+p,{method:'POST',headers:h,body:b});
  const headers={'Content-Type':'application/x-www-form-urlencoded'};
  assert.equal((await post('/token',new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:secret}),headers)).status,400);
  assert.equal((await post('/token',new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.refresh_token}),headers)).status,200);
  assert.equal((await post('/mcp','{}',{'Content-Type':'application/json',Authorization:'Bearer '+secret})).status,401);
  assert.equal((await post('/mcp',JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}),{'Content-Type':'application/json',Authorization:'Bearer legacy-secret'})).status,200);
  const logs=fs.readFileSync(path.join(tmp,'logs','homemcp.log'),'utf8');
  assert.match(logs,/"event":"oauth_request".*"outcome":"rejected".*"reason":"invalid_grant"/);
  assert.match(logs,/"event":"oauth_request".*"outcome":"accepted"/);
  assert.match(logs,/"event":"mcp_auth".*"outcome":"rejected"/);
  assert.match(logs,/"event":"mcp_auth".*"outcome":"accepted"/);
  for(const value of [clientId,secret,tokens.refresh_token,tokens.access_token])assert.equal(logs.includes(value),false,'credentials leaked');
 }finally{child.kill('SIGTERM');await wait(300);fs.rmSync(tmp,{recursive:true,force:true})}
});
