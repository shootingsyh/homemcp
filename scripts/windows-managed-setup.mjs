// Installed Windows Manager backend. No payment submission, server deletion or
// cancellation: Checkout owns payment, and the client claims only after activation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {TunnelClient,validateClaim} from '../src/tunnel-client.mjs';
import {loadSecret,saveSecret} from '../src/tunnel-store.mjs';
import {managedOrigin,enrollOrResume,switchDomainFiles,rollbackDomainFiles} from '../src/managed-domain.mjs';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const home=process.env.HOMEMCP_HOME||path.join(process.env.LOCALAPPDATA,'HomeMCP');
const [action,rawOrigin,plan='monthly']=process.argv.slice(2);
const at=(root,fn)=>{const prev=process.env.HOMEMCP_HOME;process.env.HOMEMCP_HOME=root;try{return fn()}finally{if(prev===undefined)delete process.env.HOMEMCP_HOME;else process.env.HOMEMCP_HOME=prev}};
const load=(root,name)=>at(root,()=>loadSecret(name));
const save=(root,name,value)=>at(root,()=>saveSecret(name,value));
const target=rawOrigin?managedOrigin(rawOrigin):null;
const profile=target?path.join(home,'data','managed-domains',target.hostname):null;
const tunnel=root=>path.join(root,'data','oracle-tunnel');
function cacheActive(){
 const credential=load(home,'credential');
 if(!credential)return;
 const active=managedOrigin('https://'+credential.subdomain);
 const dest=path.join(home,'data','managed-domains',active.hostname);
 fs.mkdirSync(dest,{recursive:true});
 // Retain account credentials/certificates; never copy, delete or re-enroll Passkeys.
 fs.cpSync(tunnel(home),tunnel(dest),{recursive:true});
 const bootstrap=load(home,'frp-bootstrap');if(bootstrap)save(dest,'frp-bootstrap',bootstrap);
}
function checkCertificate(){
 const certFile=path.join(tunnel(profile),'cert-production','fullchain.pem');
 if(!fs.existsSync(certFile)||!load(profile,'tls-key-production')?.key)return false;
 try{const cert=new crypto.X509Certificate(fs.readFileSync(certFile));return !!cert.checkHost(target.hostname)&&Date.parse(cert.validTo)>Date.now()+24*3600000}catch{return false}
}
async function issueCertificate(){
 if(checkCertificate())return;
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(app,'scripts','oracle-tunnel.mjs'),'certificate','--production'],{cwd:app,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,HOMEMCP_HOME:profile}});
  // The certificate helper's output stays off the Manager's JSON/diagnostic channel.
  child.stdout.resume();child.stderr.resume();
  const timer=setTimeout(()=>{child.kill();reject(Error('certificate_timeout'))},600000);
  child.once('error',()=>{clearTimeout(timer);reject(Error('certificate_start_failed'))});
  child.once('exit',code=>{clearTimeout(timer);resolve(code)});
 });
 if(code!==0||!checkCertificate())throw Error('certificate_issuance_failed');
}
try{
 if(process.platform!=='win32')throw Error('windows_required');
 let result;
 if(action==='rollback')result=rollbackDomainFiles(home);
 else{
  if(!target||!profile)throw Error('managed_domain_required');
  if(action==='begin'){
   cacheActive();fs.mkdirSync(profile,{recursive:true});
   const bootstrap=load(home,'frp-bootstrap');if(bootstrap)save(profile,'frp-bootstrap',bootstrap);
   result=await enrollOrResume({username:target.username,plan,existingCredential:load(profile,'credential'),enrollment:load(profile,'enrollment'),client:new TunnelClient(),persist:e=>save(profile,'enrollment',e),markAttempt:()=>fs.writeFileSync(path.join(profile,'enrollment-attempt.json'),JSON.stringify({at:new Date().toISOString(),plan}),{flag:'wx'})});
  }else if(action==='claim'){
   const existing=load(profile,'credential');
   if(existing)result={claimed:true,origin:'https://'+existing.subdomain};
   else{
    const enrollment=load(profile,'enrollment');if(!enrollment?.id)throw Error('enrollment_missing');
    const response=await new TunnelClient().getEnrollment(enrollment.id);
    const credential=validateClaim(response);
    if(credential){
     if(credential.subdomain!==target.hostname)throw Error('claim_domain_mismatch');
     save(profile,'credential',credential);result={claimed:true,origin:target.origin,subscriptionStatus:response.sub_status};
    }else{
     if(response.credentials_issued)throw Error('credential_already_issued_contact_support');
     if(response.status!=='pending_payment'&&response.status!=='ready')throw Error('unexpected_enrollment_status');
     result={claimed:false,status:response.status};
    }
   }
  }else if(action==='prepare'){
   if(load(profile,'credential')?.subdomain!==target.hostname)throw Error('claimed_credential_required');
   await issueCertificate();result={prepared:true,origin:target.origin};
  }else if(action==='activate'){
   if(load(profile,'credential')?.subdomain!==target.hostname||!checkCertificate())throw Error('prepared_domain_required');
   cacheActive();switchDomainFiles({home,profile,origin:target.origin});result={activated:true,origin:target.origin};
  }else throw Error('unknown_action');
 }
 console.log(JSON.stringify({ok:true,...result}));
}catch(e){console.log(JSON.stringify({ok:false,error:e.code||e.message}));process.exitCode=1}
