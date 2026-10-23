#!/usr/bin/env node
// macOS Managed setup orchestration. Explicit enrollment only; never silently
// starts a subscription. No secrets printed, no credential deletion on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadSecret,saveSecret} from '../../src/tunnel-store.mjs';
import {TunnelClient,validateClaim} from '../../src/tunnel-client.mjs';
import {frpBootstrapToken} from '../../src/frp-bootstrap.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=process.env.HOMEMCP_HOME||path.join(os.homedir(),'Library','Application Support','HomeMCP');
const configFile=path.join(base,'config.json');
const node=process.execPath;
const tool=path.join(root,'scripts','oracle-tunnel.mjs');
const helper=path.join(root,'native','macos','home-mcp-keychain');
process.env.HOMEMCP_MACOS_KEYCHAIN_HELPER=helper;
const action=process.argv[2]||'status';
const cli=(...args)=>execFileSync(node,[tool,...args],{encoding:'utf8',timeout:300000,stdio:['ignore','pipe','pipe']}).trim();
const read=()=>JSON.parse(fs.readFileSync(configFile,'utf8'));
const write=c=>{const temp=configFile+'.managed-'+process.pid;fs.writeFileSync(temp,JSON.stringify(c,null,2),{mode:0o600});fs.renameSync(temp,configFile)};
const launch=(...args)=>execFileSync('/bin/launchctl',args,{stdio:'ignore',timeout:15000});
const domain=c=>'https://'+c.subdomain;
const pending=()=>loadSecret('enrollment');
try{
 if(process.platform!=='darwin')throw Error('macos_required');
 if(action==='status'){
  const c=loadSecret('credential'),e=pending();
  console.log(JSON.stringify({claimed:!!c,origin:c?domain(c):null,enrollmentPending:!!e,bootstrapReady:!!c}));
 }else if(action==='enroll'){
  // Starts an enrollment request that may require a paid subscription.
  // Caller must display explicit confirmation and collect username/plan.
  const username=process.argv[3],plan=process.argv[4];
  if(!/^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])?$/.test(username||''))throw Error('invalid_username');
  if(!['monthly','annual'].includes(plan))throw Error('invalid_plan');
  if(loadSecret('credential'))throw Error('already_claimed');
  if(pending())throw Error('enrollment_exists_claim_first');
  console.log(cli('enroll',username,plan));
 }else if(action==='claim'){
  const e=pending();if(!e?.id)throw Error('enroll_first');
  const r=await new TunnelClient().getEnrollment(e.id);
  const credential=validateClaim(r);
  if(!credential){console.log(JSON.stringify({claimed:false,status:r.status}));}
  else{saveSecret('credential',credential);console.log(JSON.stringify({claimed:true,origin:domain(credential)}));}
 }else if(action==='activate'){
  const credential=loadSecret('credential');if(!credential)throw Error('claim_first');
  frpBootstrapToken(credential,{override:process.env.HOMEMCP_FRP_BOOTSTRAP_OVERRIDE});
  const candidates=[process.env.HOMEMCP_FRPC_BIN,path.join(root,'runtime','frpc'),'/opt/homebrew/bin/frpc','/usr/local/bin/frpc'].filter(Boolean);
  const frpc=candidates.find(f=>fs.existsSync(f));
  if(!frpc)throw Error('frpc_binary_missing_install_frpc_first');
  // Issuance uses production LE DNS-01 and may take minutes.
  const cert=path.join(base,'data','oracle-tunnel','cert-production','fullchain.pem');
  if(!fs.existsSync(cert)||!loadSecret('tls-key-production')?.key)cli('certificate','--production');
  const c=read(),origin=domain(credential);
  if(c.publicUrl&&c.publicUrl!==origin)throw Error('existing_domain_rebind_requires_migration');
  const old=JSON.stringify(c,null,2);
  const updated={...c,publicUrl:origin,connectionMode:'managed',security:{...c.security,rpOrigin:origin,rpID:credential.subdomain},oauth:{...c.oauth,enabled:true}};
  delete updated.oauth.issuer;
  try{
   write(updated);
   const uid=process.getuid(),agentDir=path.join(os.homedir(),'Library','LaunchAgents');
   const main=path.join(agentDir,'xyz.shootingsyh.homemcp.plist');
   if(fs.existsSync(main)){try{launch('kickstart','-k','gui/'+uid+'/xyz.shootingsyh.homemcp')}catch{}}
   execFileSync(node,[path.join(root,'scripts','macos','write-managed-launchagents.mjs')],{stdio:'pipe',env:{...process.env,HOMEMCP_FRPC_BIN:frpc}});
   for(const name of ['gateway','frpc']){
    const label='si.homemcp.'+name,plist=path.join(agentDir,label+'.plist');
    try{launch('bootout','gui/'+uid,plist)}catch{}
    launch('bootstrap','gui/'+uid,plist);
    launch('kickstart','-k','gui/'+uid+'/'+label);
   }
   // Verify that the public HTTPS endpoint is serving the current Host, not
   // merely that frpc launched. The local challenge is short-lived and bound
   // to this installation; no token or secret is exposed through the tunnel.
   const local='http://127.0.0.1:'+updated.port;
   const challengeRes=await fetch(local+'/admin/tunnel-check',{method:'POST',headers:{Authorization:'Bearer '+updated.security.adminToken},signal:AbortSignal.timeout(10000)});
   if(!challengeRes.ok)throw Error('local_tunnel_check_failed');
   const challenge=await challengeRes.json();
   let verified=false;
   for(let i=0;i<12;i++){
    try{
     const result=await fetch(origin+challenge.path,{signal:AbortSignal.timeout(4000),redirect:'error'});
     if(result.ok&&(await result.json()).nonce===challenge.nonce){verified=true;break}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,1500));
   }
   if(!verified)throw Error('managed_tunnel_public_verification_failed');
   const metadata=await fetch(origin+'/.well-known/oauth-authorization-server',{signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!metadata.ok||(await metadata.json()).issuer!==origin)throw Error('managed_oauth_issuer_mismatch');
   console.log(JSON.stringify({active:true,origin}));
  }catch(e){
   write(JSON.parse(old));
   throw e;
  }
 }else throw Error('usage: managed-setup.mjs status|enroll username plan|claim|activate');
}catch(e){console.error('MANAGED_SETUP_ERROR',e.message);process.exitCode=1}
