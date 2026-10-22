#!/usr/bin/env node
// macOS first-run, local restore and verified BYOT binding. Never trusts a DNS record as proof
// that the chosen HTTPS endpoint belongs to this HomeMCP installation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {execFileSync} from 'node:child_process';

const base=process.env.HOMEMCP_HOME||path.join(os.homedir(),'Library','Application Support','HomeMCP');
const configPath=path.join(base,'config.json');
const [mode,...args]=process.argv.slice(2);
const load=()=>JSON.parse(fs.readFileSync(configPath,'utf8'));
const write=data=>{
 const temp=configPath+'.tmp-'+process.pid;
 try {
  fs.writeFileSync(temp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});
  fs.renameSync(temp,configPath);
  fs.chmodSync(configPath,0o600);
 }finally{try{fs.unlinkSync(temp)}catch{}}
};
function originURL(raw){
 if(typeof raw!=='string'||raw.length>512||raw.includes('#'))throw Error('invalid_https_origin');
 const uri=new URL(raw);
 if(uri.protocol!=='https:'||uri.username||uri.password||uri.port||uri.pathname!=='/'||uri.search||uri.hash||net.isIP(uri.hostname)||
  /(^localhost$|\.localhost$|\.local$)/i.test(uri.hostname))throw Error('invalid_https_origin');
 return uri.origin;
}
function publicIP(entry){
 if(entry.family===4){
  const [a,b,c]=entry.address.split('.').map(Number);
  return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0))&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
 }
 if(entry.family===6){
  const s=entry.address.toLowerCase();
  if(s.startsWith('2001:db8:'))return false;
  const first=parseInt(s.split(':')[0],16);
  return Number.isFinite(first)&&first>=0x2000&&first<0x4000;
 }
 return false;
}
async function publicAddresses(host){
 const records=await lookup(host,{all:true,verbatim:true});
 if(!records.length||records.some(r=>!publicIP(r)))throw Error('dns_not_public');
 return records;
}
async function requestPinned(origin,pathname,selected){
 const uri=new URL(pathname,origin);
 return new Promise((resolve,reject)=>{
  const req=https.request(uri,{method:'GET',timeout:10000,headers:{Accept:'application/json'},lookup:(_host,options,cb)=>{
   if(options?.all)cb(null,[selected]);else cb(null,selected.address,selected.family);
  }},res=>{
   if(res.statusCode!==200){res.resume();reject(Error('remote_http_'+res.statusCode));return}
   let data='';
   res.on('data',chunk=>{data+=chunk;if(data.length>65536){req.destroy(Error('remote_payload_too_large'))}});
   res.once('end',()=>{try{resolve(JSON.parse(data))}catch{reject(Error('remote_invalid_json'))}});
  });
  req.on('timeout',()=>req.destroy(Error('remote_timeout')));
  req.once('error',reject);req.end();
 });
}
async function verify(origin,config){
 const addresses=await publicAddresses(new URL(origin).hostname);
 const admin=config.security?.adminToken;
 if(!admin||!Number.isInteger(config.port)||config.port<=0)throw Error('local_host_not_configured');
 const local=await fetch('http://127.0.0.1:'+config.port+'/admin/tunnel-check',{method:'POST',headers:{Authorization:'Bearer '+admin},signal:AbortSignal.timeout(5000)});
 if(!local.ok)throw Error('local_challenge_failed');
 const check=await local.json();
 // Every HTTPS fetch pins its destination to the validated DNS address, while retaining
 // standard hostname/SNI verification. No proxy, redirect, plaintext or arbitrary URL path.
 const get=p=>requestPinned(origin,p,addresses[0]);
 const proof=await get(check.path);
 if(proof.nonce!==check.nonce)throw Error('wrong_tunnel_destination');
 const auth=await get('/.well-known/oauth-authorization-server');
 if(auth.issuer!==origin)throw Error('oauth_issuer_mismatch');
 const resource=await get('/.well-known/oauth-protected-resource');
 if(resource.resource!==origin+'/mcp')throw Error('mcp_resource_mismatch');
}
function restart(){
 if(process.platform!=='darwin')throw Error('setup_requires_macos');
 execFileSync('/bin/launchctl',['kickstart','-k','gui/'+process.getuid()+'/xyz.shootingsyh.homemcp'],{timeout:15000,stdio:'ignore'});
}
async function waitLocal(config){
 for(let i=0;i<30;i++){
  try{const r=await fetch('http://127.0.0.1:'+config.port+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ok)return}catch{}
  await new Promise(r=>setTimeout(r,250));
 }
 throw Error('local_host_not_ready');
}
try{
 if(mode==='status'){
  const c=load();
  console.log(JSON.stringify({configured:!!c.publicUrl,origin:c.publicUrl||null,mode:c.connectionMode||'local'}));
 }else if(mode==='restore'){
  if(!fs.existsSync(configPath))throw Error('no_local_config; managed cloud recovery not implemented');
  restart();await waitLocal(load());console.log('RESTORED_LOCAL_SETUP');
 }else if(mode==='byot'){
  if(args.length!==1)throw Error('usage: setup.mjs byot https://your-domain.example');
  const origin=originURL(args[0]),current=load();
  if(current.publicUrl&&current.publicUrl!==origin)throw Error('existing_domain_rebind_requires_explicit_migration');
  // Pre-validate DNS before any mutation. Host must be started with its prospective issuer
  // before it can correctly expose the OAuth discovery metadata.
  await publicAddresses(new URL(origin).hostname);
  const backup=configPath+'.before-byot-'+crypto.randomUUID()+'.bak';
  fs.copyFileSync(configPath,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
  let staged=false;
  try{
   const next={...current,publicUrl:origin,security:{...current.security,rpOrigin:origin,rpID:new URL(origin).hostname},oauth:{...current.oauth,enabled:true},connectionMode:'byot'};
   delete next.oauth.issuer;
   write(next);staged=true;restart();await waitLocal(next);await verify(origin,next);
   console.log('BYOT_VERIFIED '+origin+'; configure Passkey from the local Manager.');
  }catch(e){
   if(staged){
    fs.copyFileSync(backup,configPath);fs.chmodSync(configPath,0o600);
    try{restart()}catch{console.error('HomeMCP setup: rollback restart requires attention')}
   }
   throw e;
  }
 }else throw Error('usage: setup.mjs status | restore | byot https://your-domain.example');
}catch(e){console.error('HomeMCP setup:',e.message);process.exitCode=1}
