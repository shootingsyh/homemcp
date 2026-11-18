import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
// Persist an encryption key protected by Windows DPAPI or macOS Keychain.
// Linux test/development uses a local file with owner-only permissions.
const retryKeyFile='oauth-retry-key-v1';
function systemProtect(platform,operation,input){
 if(platform==='win32'){
  const script=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts/credential-dpapi.ps1');
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const binding=Buffer.from('HomeMCP OAuth Refresh Replay Key v1','utf8').toString('base64');
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Operation',operation,'-Binding',binding],{
   input:input.toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:8192
  });
  if(r.status!==0||!/^[A-Za-z0-9+/=]+$/.test(r.stdout?.trim()||''))throw Error('oauth_retry_key_protection_failed');
  return Buffer.from(r.stdout.trim(),'base64');
 }
 if(platform==='darwin'){
  const helper=process.env.HOMEMCP_MACOS_KEYCHAIN_HELPER||
   path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../native/macos/home-mcp-keychain');
  const r=spawnSync(helper,[],{input:JSON.stringify({
   operation,binding:Buffer.from('HomeMCP OAuth Refresh Replay Key v1').toString('base64'),
   data:input.toString('base64')}),encoding:'utf8',timeout:15000,maxBuffer:8192});
  if(r.status!==0)throw Error('oauth_retry_key_protection_failed');
  try{return Buffer.from(JSON.parse(r.stdout).data,'base64')}
  catch{throw Error('oauth_retry_key_protection_failed')}
 }
 if(platform==='linux')return input;
 throw Error('oauth_retry_key_protection_unavailable');
}
function loadRetryKey(dir,{platform=process.platform}={}){
 const suffix=platform==='win32'?'.dpapi':platform==='darwin'?'.keychain':'.local';
 const file=path.join(dir,retryKeyFile+suffix);
 if(fs.existsSync(file)){
  const key=systemProtect(platform,'unprotect',fs.readFileSync(file));
  if(key.length!==32)throw Error('oauth_retry_key_invalid');
  return key;
 }
 const key=crypto.randomBytes(32);
 const blob=systemProtect(platform,'protect',key);
 try{fs.writeFileSync(file,blob,{flag:'wx',mode:0o600});return key}
 catch(e){if(e.code==='EEXIST')return loadRetryKey(dir,{platform});throw e}
}
const RETRY_MS=120000;
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const token=()=>crypto.randomBytes(32).toString('base64url');
const safeEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&crypto.timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));
const allowedRedirect=s=>{try{const u=new URL(s);return !u.username&&!u.password&&!u.hash&&((u.protocol==='https:')||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)));}catch{return false}};
export class HomeOAuth{
 constructor(dataDir,issuer){const u=new URL(issuer);if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('oauth_https_issuer_required');this.issuer=u.origin;this.resource=this.issuer+'/mcp';this.retryKey=loadRetryKey(dataDir);this.db=new DatabaseSync(path.join(dataDir,'oauth.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,redirects TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY,client TEXT NOT NULL,redirect TEXT NOT NULL,challenge TEXT NOT NULL,resource TEXT NOT NULL,scope TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS access(hash TEXT PRIMARY KEY,client TEXT NOT NULL,resource TEXT NOT NULL,expires INTEGER NOT NULL,family TEXT);
 CREATE TABLE IF NOT EXISTS refresh(hash TEXT PRIMARY KEY,client TEXT NOT NULL,resource TEXT NOT NULL,expires INTEGER NOT NULL,family TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS refresh_family ON refresh(family);
 CREATE TABLE IF NOT EXISTS refresh_retry(
 parent_hash TEXT PRIMARY KEY, client TEXT NOT NULL, resource TEXT NOT NULL,
 family TEXT NOT NULL, successor_hash TEXT NOT NULL,
 encrypted_response BLOB NOT NULL, retry_until INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS refresh_retry_family ON refresh_retry(family);`)}
 metadata(){return {issuer:this.issuer,authorization_endpoint:this.issuer+'/authorize',token_endpoint:this.issuer+'/token',registration_endpoint:this.issuer+'/register',revocation_endpoint:this.issuer+'/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:['mcp','offline_access'],client_id_metadata_document_supported:false}}
 protectedMetadata(){return {resource:this.resource,authorization_servers:[this.issuer],scopes_supported:['mcp','offline_access'],bearer_methods_supported:['header']}}
 register(data){if(data?.token_endpoint_auth_method&&!['none'].includes(data.token_endpoint_auth_method))throw Error('unsupported_client_auth');if(!Array.isArray(data?.redirect_uris)||data.redirect_uris.length<1||data.redirect_uris.length>8||!data.redirect_uris.every(x=>typeof x==='string'&&x.length<2048&&allowedRedirect(x)))throw Error('invalid_redirect_uris');const id=token();this.db.prepare('INSERT INTO clients VALUES(?,?,?)').run(id,JSON.stringify(data.redirect_uris),Date.now());return {client_id:id,client_id_issued_at:Math.floor(Date.now()/1000),redirect_uris:data.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}}
 validateAuth(p){const client=this.db.prepare('SELECT * FROM clients WHERE id=?').get(p.get('client_id')||'');if(!client)throw Error('invalid_client');const redirect=p.get('redirect_uri');if(!JSON.parse(client.redirects).includes(redirect))throw Error('invalid_redirect_uri');if(p.get('response_type')!=='code'||p.get('code_challenge_method')!=='S256'||!(/^[A-Za-z0-9_-]{43,128}$/.test(p.get('code_challenge')||'')))throw Error('invalid_request');const resource=p.get('resource');if(resource!==null&&resource!==this.resource&&resource!==this.issuer)throw Error('invalid_target');const scope=p.get('scope')||'mcp';if(!scope.split(' ').every(s=>['mcp','offline_access'].includes(s))||!scope.split(' ').includes('mcp'))throw Error('invalid_scope');return {client:client.id,redirect,challenge:p.get('code_challenge'),state:p.get('state')||'',resource:this.resource,scope}}
 issueCode(auth){const code=token();this.db.prepare('INSERT INTO codes VALUES(?,?,?,?,?,?,?)').run(digest(code),auth.client,auth.redirect,auth.challenge,auth.resource,auth.scope,Date.now()+120000);return code}
 transaction(action){
  this.db.exec('BEGIN IMMEDIATE');
  try{const result=action();this.db.exec('COMMIT');return result}
  catch(e){this.db.exec('ROLLBACK');throw e}
 }
 issueTokens(client,resource,scope,family=null){
  return this.transaction(()=>this._issueTokens(client,resource,scope,family));
 }
 _issueTokens(client,resource,scope,family=null){
  const a=token(),r=scope.split(' ').includes('offline_access')?token():null,now=Date.now();
  const grantFamily=r?(family||token()):null;
  this.db.prepare('INSERT INTO access VALUES(?,?,?,?,?)').run(digest(a),client,resource,now+3600000,grantFamily);
  if(r)this.db.prepare('INSERT INTO refresh VALUES(?,?,?,?,?,0)').run(digest(r),client,resource,now+90*86400000,grantFamily);
  return {access_token:a,token_type:'Bearer',expires_in:3600,scope,...(r?{refresh_token:r}:{})};
 }
 exchange(form){
  this.lastRefreshOutcome=null;
  this.lastRetryAgeMs=null;
  const client=form.get('client_id'),grant=form.get('grant_type'),resource=form.get('resource');
  if(resource!==null&&resource!==this.resource&&resource!==this.issuer)throw Error('invalid_target');
  if(grant==='authorization_code'){
   const code=form.get('code')||'',hash=digest(code);
   const row=this.db.prepare('SELECT * FROM codes WHERE hash=?').get(hash);
   if(!row||row.expires<Date.now()||row.client!==client||row.resource!==this.resource||row.redirect!==form.get('redirect_uri'))throw Error('invalid_grant');
   const verifier=form.get('code_verifier')||'';
   if(!/^[A-Za-z0-9_.~-]{43,128}$/.test(verifier)||!safeEqual(crypto.createHash('sha256').update(verifier).digest('base64url'),row.challenge))throw Error('invalid_grant');
   return this.transaction(()=>{
    const deleted=this.db.prepare('DELETE FROM codes WHERE hash=?').run(hash);
    if(deleted.changes!==1)throw Error('invalid_grant');
    return this._issueTokens(client,row.resource,row.scope);
   });
  }
  if(grant==='refresh_token'){
   const hash=digest(form.get('refresh_token')||'');
   return this.transaction(()=>{
    const row=this.db.prepare('SELECT * FROM refresh WHERE hash=?').get(hash);
    if(!row||row.client!==client||row.resource!==this.resource||row.expires<Date.now())throw Error('invalid_grant');
    if(row.used){
     const retry=this.db.prepare('SELECT * FROM refresh_retry WHERE parent_hash=?').get(hash);
     if(!retry||retry.client!==client||retry.resource!==this.resource||retry.family!==row.family||
        retry.retry_until<Date.now())throw Error('invalid_grant');
     // Only the direct predecessor of the current unused refresh token can be retried.
     const successor=this.db.prepare('SELECT used,expires,client,resource,family FROM refresh WHERE hash=?').get(retry.successor_hash);
     if(!successor||successor.used||successor.expires<Date.now()||successor.client!==client||
        successor.resource!==this.resource||successor.family!==row.family)throw Error('invalid_grant');
     const response=this.openRetryResponse(retry.encrypted_response,hash,client);
     this.lastRefreshOutcome='replayed';
     this.lastRetryAgeMs=Math.max(0,Date.now()-(retry.retry_until-RETRY_MS));
     return response;
    }
    const updated=this.db.prepare('UPDATE refresh SET used=1 WHERE hash=? AND used=0').run(hash);
    if(updated.changes!==1)throw Error('invalid_grant');
    const response=this._issueTokens(client,row.resource,'mcp offline_access',row.family);
    this.db.prepare('DELETE FROM refresh_retry WHERE family=?').run(row.family);
    this.db.prepare('DELETE FROM refresh_retry WHERE retry_until<?').run(Date.now());
    this.db.prepare('INSERT INTO refresh_retry VALUES(?,?,?,?,?,?,?)').run(
     hash,client,row.resource,row.family,digest(response.refresh_token),
     this.sealRetryResponse(response,hash,client),Date.now()+RETRY_MS);
    this.lastRefreshOutcome='rotated';
    return response;
   });
  }
  throw Error('unsupported_grant_type');
 }
 sealRetryResponse(response,hash,client){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.retryKey,iv);
  cipher.setAAD(Buffer.from(hash+'\\0'+client+'\\0'+this.resource));
  const body=Buffer.concat([cipher.update(JSON.stringify(response),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]);
 }
 openRetryResponse(blob,hash,client){
  const b=Buffer.from(blob);
  if(b.length<29)throw Error('invalid_grant');
  const decipher=crypto.createDecipheriv('aes-256-gcm',this.retryKey,b.subarray(0,12));
  decipher.setAAD(Buffer.from(hash+'\\0'+client+'\\0'+this.resource));
  decipher.setAuthTag(b.subarray(12,28));
  try{return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8'))}
  catch{throw Error('invalid_grant')}
 }
 diagnoseRefreshFailure(form){
  const value=form.get('refresh_token')||'';
  const client=form.get('client_id')||'';
  const resource=form.get('resource');
  if(resource!==null&&resource!==this.resource&&resource!==this.issuer)return 'invalid_target';
  if(!value)return 'missing_refresh_token';
  const row=this.db.prepare('SELECT client,resource,expires,used FROM refresh WHERE hash=?').get(digest(value));
  if(!row)return 'token_unknown';
  if(row.client!==client)return 'client_mismatch';
  if(row.resource!==this.resource)return 'resource_mismatch';
  if(row.used)return 'token_used';
  if(row.expires<Date.now())return 'token_expired';
  return 'other';
 }
 revokeFamily(family){
  return this.transaction(()=>this._revokeFamily(family));
 }
 _revokeFamily(family){
  this.db.prepare('DELETE FROM refresh_retry WHERE family=?').run(family);
  this.db.prepare('DELETE FROM refresh WHERE family=?').run(family);
  this.db.prepare('DELETE FROM access WHERE family=?').run(family);
 }
 revoke(value,client){const hash=digest(value||'');const row=this.db.prepare('SELECT family FROM refresh WHERE hash=? AND client=?').get(hash,client);if(row){this.revokeFamily(row.family);return}this.db.prepare('DELETE FROM access WHERE hash=? AND client=?').run(hash,client)}
 authorized(value){if(typeof value!=='string'||value.length>256)return false;const row=this.db.prepare('SELECT expires,resource FROM access WHERE hash=?').get(digest(value));return !!row&&row.expires>Date.now()&&row.resource===this.resource}
 close(){this.db.close()}
}
