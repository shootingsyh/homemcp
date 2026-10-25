import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function managedOrigin(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||!/^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\.tunnel\.homemcp\.si$/.test(url.hostname))throw Error('invalid_managed_domain');
 return {origin:url.origin,hostname:url.hostname,username:url.hostname.split('.')[0]};
}
export function checkedCheckout(value){
 if(!value)return null;
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('invalid_checkout_url');
 if(url.hostname==='checkout.stripe.com'&&/^\/c\/pay\/cs_(live|test)_/.test(url.pathname))return url.href;
 if(url.hostname==='api.homemcp.si'&&url.pathname.startsWith('/mock-pay/'))return url.href;
 throw Error('invalid_checkout_url');
}
export async function enrollOrResume({username,plan,existingCredential,enrollment,client,persist,markAttempt}){
 if(!['monthly','annual'].includes(plan))throw Error('invalid_plan');
 if(existingCredential)return {claimed:true,origin:'https://'+existingCredential.subdomain};
 if(enrollment){
  if(enrollment.username!==username)throw Error('enrollment_domain_mismatch');
  return {claimed:false,status:'pending_payment',checkoutUrl:checkedCheckout(enrollment.checkout_url),resumed:true};
 }
 markAttempt(); // A failed/ambiguous POST must not be retried automatically.
 const result=await client.enroll(username,plan);
 if(typeof result.enrollment_id!=='string'||!result.enrollment_id)throw Error('invalid_enrollment_response');
 // Save the capability before validating the rest: do not lose a created registration.
 persist({id:result.enrollment_id,username,plan,subdomain:result.subdomain,checkout_url:result.checkout_url});
 if(!['pending_payment','ready'].includes(result.status))throw Error('unexpected_enrollment_status');
 return {claimed:false,status:result.status,checkoutUrl:checkedCheckout(result.checkout_url),resumed:false};
}
export function nextDomainConfig(current,origin){
 const target=managedOrigin(origin);
 const previous=current.security?.rpID||(current.publicUrl?new URL(current.publicUrl).hostname:null);
 const passkeyDomains={...current.security?.passkeyDomains};
 if(previous)passkeyDomains[previous]=current.security?.passkeyDataDir||current.dataDir;
 const passkeyDataDir=passkeyDomains[target.hostname]||path.join(current.dataDir,'domains',target.hostname);
 passkeyDomains[target.hostname]=passkeyDataDir;
 return {...current,publicUrl:target.origin,connectionMode:'managed',security:{...current.security,rpOrigin:target.origin,rpID:target.hostname,passkeyDomains,passkeyDataDir},oauth:{...current.oauth,enabled:true,issuer:undefined}};
}
function atomic(file,bytes,io=fs){
 const tmp=file+'.tmp-'+crypto.randomUUID();
 try{io.writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});io.renameSync(tmp,file)}finally{if(io.existsSync(tmp))io.unlinkSync(tmp)}
}
// Caller must stop the Host/gateway first. Authentication databases are never moved,
// reset or replaced: switching back to the old RP ID preserves its existing Passkeys.
export function switchDomainFiles({home,profile,origin,io=fs}){
 managedOrigin(origin);
 const configFile=path.join(home,'config.json'),stateFile=path.join(home,'network-setup.json');
 const oldConfig=io.readFileSync(configFile);
 const oldState=io.existsSync(stateFile)?io.readFileSync(stateFile):null;
 const config=nextDomainConfig(JSON.parse(oldConfig.toString('utf8').replace(/^\uFEFF/,'')),origin);
 const active=path.join(home,'data','oracle-tunnel');
 const source=path.join(profile,'data','oracle-tunnel');
 if(!io.existsSync(path.join(source,'credential.dpapi')))throw Error('claimed_credential_required');
 const id=crypto.randomUUID(),backup=active+'.before-domain-'+id,staged=active+'.next-'+id;
 const configBackup=configFile+'.before-managed-'+id,stateBackup=stateFile+'.before-managed-'+id;
 io.mkdirSync(path.dirname(active),{recursive:true});
 io.writeFileSync(configBackup,oldConfig,{mode:0o600,flag:'wx'});
 if(oldState)io.writeFileSync(stateBackup,oldState,{mode:0o600,flag:'wx'});
 io.cpSync(source,staged,{recursive:true});
 const hadActive=io.existsSync(active);let moved=false,installed=false;
 try{
  if(hadActive){io.renameSync(active,backup);moved=true}
  io.renameSync(staged,active);installed=true;
  atomic(configFile,JSON.stringify(config,null,2),io);
  atomic(stateFile,JSON.stringify({...JSON.parse(oldState?.toString('utf8').replace(/^\uFEFF/,'')||'{}'),mode:'managed',url:origin,hostname:new URL(origin).hostname,remoteEnabled:true},null,2),io);
  const journal={origin,backup,hadActive,configBackup,stateBackup,hadState:!!oldState};
  atomic(path.join(home,'managed-domain-switch.json'),JSON.stringify(journal),io);
  return journal;
 }catch(e){
  if(installed&&io.existsSync(active))io.rmSync(active,{recursive:true});
  if(moved)io.renameSync(backup,active);
  atomic(configFile,oldConfig,io);
  if(oldState)atomic(stateFile,oldState,io);else if(io.existsSync(stateFile))io.unlinkSync(stateFile);
  throw e;
 }finally{if(io.existsSync(staged))io.rmSync(staged,{recursive:true})}
}
export function rollbackDomainFiles(home){
 const journal=JSON.parse(fs.readFileSync(path.join(home,'managed-domain-switch.json'),'utf8'));
 const configFile=path.join(home,'config.json'),stateFile=path.join(home,'network-setup.json');
 const current=JSON.parse(fs.readFileSync(configFile,'utf8'));
 if(current.publicUrl!==journal.origin)throw Error('rollback_origin_mismatch');
 for(const file of [journal.backup,journal.configBackup,journal.stateBackup])if(!path.resolve(file).startsWith(path.resolve(home)+path.sep))throw Error('invalid_rollback_path');
 const active=path.join(home,'data','oracle-tunnel');
 if(journal.hadActive&&!fs.existsSync(journal.backup))throw Error('rollback_already_used_or_missing');
 if(fs.existsSync(active))fs.renameSync(active,active+'.failed-'+crypto.randomUUID());
 if(journal.hadActive)fs.renameSync(journal.backup,active);
 atomic(configFile,fs.readFileSync(journal.configBackup));
 if(journal.hadState)atomic(stateFile,fs.readFileSync(journal.stateBackup));else if(fs.existsSync(stateFile))fs.unlinkSync(stateFile);
 fs.renameSync(path.join(home,'managed-domain-switch.json'),path.join(home,'managed-domain-switch.used-'+crypto.randomUUID()+'.json'));
 return {restored:true,origin:JSON.parse(fs.readFileSync(configFile,'utf8')).publicUrl};
}
