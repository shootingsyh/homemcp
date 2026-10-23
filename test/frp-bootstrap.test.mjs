import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {OFFICIAL_FRP_BOOTSTRAP_TOKEN,isOfficialFrp,frpBootstrapToken,renderFrpcConfig,configuredFrpOverride} from '../src/frp-bootstrap.mjs';

const credential=(subdomain='clientdev.tunnel.homemcp.si',token='test-per-user-token-abc')=>({
 subdomain,token,
 frpc_config:'serverAddr = "tunnel.homemcp.si"\nauth.token = "BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP"\nmetadatas.tenant = "{{ .Envs.HOMEMCP_FRP_TENANT }}"\n'
});

test('official frpc config renders without any provisioned bootstrap secret',()=>{
 const c=renderFrpcConfig(credential());
 assert.ok(c.includes(OFFICIAL_FRP_BOOTSTRAP_TOKEN));
 assert.ok(c.includes('test-per-user-token-abc'));
 assert.ok(!c.includes('BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP'));
});
test('official token is public and is NOT a substitute for per-user token',()=>{
 const good=renderFrpcConfig(credential());
 const bad=renderFrpcConfig(credential('clientdev.tunnel.homemcp.si','wrong-tenant-token'));
 assert.ok(good.includes(OFFICIAL_FRP_BOOTSTRAP_TOKEN));
 assert.ok(bad.includes(OFFICIAL_FRP_BOOTSTRAP_TOKEN));
 assert.notEqual(good,bad);
 assert.ok(bad.includes('wrong-tenant-token'));
 // Actual rejection by the server plugin requires integration against frps.
});
test('self-host requires explicit override and never receives official bootstrap',()=>{
 const c=credential('home.example.org');
 assert.equal(isOfficialFrp(c),false);
 assert.throws(()=>frpBootstrapToken(c),/self_hosted_frp_token_required/);
 const rendered=renderFrpcConfig(c,{override:'my-private-self-host-frps-token'});
 assert.ok(rendered.includes('my-private-self-host-frps-token'));
 assert.ok(!rendered.includes(OFFICIAL_FRP_BOOTSTRAP_TOKEN));
});
test('client setting can provide custom frps auth token',()=>{
 const prior=process.env.HOMEMCP_HOME;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-frps-setting-'));
 try{
  process.env.HOMEMCP_HOME=home;
  fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({frp:{bootstrapToken:'self-host-setting'}}));
  assert.equal(configuredFrpOverride(),'self-host-setting');
 }finally{
  if(prior===undefined)delete process.env.HOMEMCP_HOME;else process.env.HOMEMCP_HOME=prior;
  fs.rmSync(home,{recursive:true,force:true});
 }
});
