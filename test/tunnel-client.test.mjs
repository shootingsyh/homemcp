import {test} from 'node:test';import assert from 'node:assert/strict';
import {TunnelClient,TunnelAPIError,validateClaim} from '../src/tunnel-client.mjs';
const mock=(status,body)=>async()=>({ok:status>=200&&status<300,status,json:async()=>body});
test('production API handles unconfigured Stripe as typed error',async()=>{
  const c=new TunnelClient({fetchImpl:mock(503,{error:{code:'stripe_not_configured',message:'unavailable'}})});
  await assert.rejects(c.enroll('test','annual'),e=>e instanceof TunnelAPIError&&e.code==='stripe_not_configured'&&e.status===503);
});
test('account bearer authorization and DNS challenge endpoints',async()=>{
  const calls=[];const c=new TunnelClient({token:'testtoken',fetchImpl:async(url,opts)=>{calls.push({url:url.href,...opts});return {ok:true,json:async()=>({status:'propagated',id:'abc'})}}});
  await c.account();await c.createChallenge('a'.repeat(43));await c.challenge('abc');await c.removeChallenge('abc');
  assert.equal(calls.length,4);assert(calls.every(x=>x.headers.Authorization==='Bearer testtoken'));
  assert.equal(JSON.parse(calls[1].body).value,'a'.repeat(43));assert.equal(calls[3].method,'DELETE');
});
test('DNS cleanup executes even when ACME verification fails',async()=>{
  const methods=[];const c=new TunnelClient({token:'t',fetchImpl:async(url,opts)=>{methods.push(opts.method);return {ok:true,json:async()=>({id:'abc',status:opts.method==='POST'?'pending':'propagated'})}}});
  await assert.rejects(c.withDNSChallenge('b'.repeat(43),async()=>{throw Error('ca_failed')},{intervalMs:1}),/ca_failed/);
  assert.deepEqual(methods,['POST','GET','DELETE']);
});
test('reject incomplete one-time credential claim',()=>{
  assert.equal(validateClaim({status:'ready'}),null);
  assert.throws(()=>validateClaim({status:'claimed',credentials:{subdomain:'fake.example',token:'A'.repeat(43),frpc_config:'BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP'}}),/invalid_claim/);
});

test('mock-account deletion requires bearer and uses DELETE',async()=>{
 const calls=[];const c=new TunnelClient({token:'mock-token',fetchImpl:async(u,o)=>{calls.push(o);return {ok:true,json:async()=>({status:'deleted'})}}});
 await c.deleteMockAccount();assert.equal(calls[0].method,'DELETE');assert.equal(calls[0].headers.Authorization,'Bearer mock-token');
});

test('status polling is read-only; claim persists before ack',async()=>{
 const calls=[];const token='T'.repeat(43);let saved=false;
 const c=new TunnelClient({fetchImpl:async(u,o)=>{
  calls.push([o.method,new URL(u).pathname,o.body&&JSON.parse(o.body)]);
  const path=new URL(u).pathname;
  if(path.endsWith('/claim/ack')){assert(saved);assert.equal(JSON.parse(o.body).token,token)}
  const body=path.endsWith('/claim')?{status:'claimed',credentials:{subdomain:'alice.tunnel.homemcp.si',token,frpc_config:'BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP'}}:{status:'ready'};
  return {ok:true,status:200,json:async()=>body};
 }});
 await c.getEnrollment('abc');
 await c.claimAndSave('abc',async()=>{saved=true});
 assert.deepEqual(calls.map(x=>x[0]),['GET','GET','POST','POST']);
 assert.equal(calls[3][1],'/api/v1/enrollments/abc/claim/ack');
});
test('save error leaves claim unacked and safely retryable',async()=>{
 let ackCount=0,claims=0;
 const c=new TunnelClient({fetchImpl:async(u,o)=>{
  const path=new URL(u).pathname;
  if(path.endsWith('/claim'))claims++;
  if(path.endsWith('/claim/ack'))ackCount++;
  return {ok:true,status:200,json:async()=>path.endsWith('/claim')?{status:'claimed',credentials:{subdomain:'alice.tunnel.homemcp.si',token:'T'.repeat(42)+claims,frpc_config:'BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP'}}:{status:'ready'}};
 }});
 await assert.rejects(c.claimAndSave('abc',()=>{throw Error('disk_full')}),/disk_full/);
 assert.equal(ackCount,0);
 await c.claimAndSave('abc',()=>{});
 assert.equal(claims,2);assert.equal(ackCount,1);
});
test('stale ack reclaims, resaves and acknowledges fresh token',async()=>{
 let claims=0,saves=0;
 const c=new TunnelClient({fetchImpl:async(u,o)=>{
  const path=new URL(u).pathname;
  if(path.endsWith('/claim'))claims++;
  if(path.endsWith('/claim/ack')&&claims===1)return {ok:false,status:409,json:async()=>({error:{code:'stale_claim'}})};
  return {ok:true,status:200,json:async()=>path.endsWith('/claim')?{status:'claimed',credentials:{subdomain:'alice.tunnel.homemcp.si',token:'T'.repeat(42)+claims,frpc_config:'BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP'}}:{status:'ready'}};
 }});
 await c.claimAndSave('abc',()=>{saves++});assert.equal(claims,2);assert.equal(saves,2);
});
