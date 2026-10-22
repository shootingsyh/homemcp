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
