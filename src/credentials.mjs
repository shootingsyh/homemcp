import {createCredentialProtector} from './platform/credential-protector.mjs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import {getDomain} from 'tldts';

export function normalizeOrigin(raw){
 if(typeof raw!=='string'||raw.length>512)throw new Error('invalid_origin');
 let url;
 try{url=new URL(raw)}catch{throw new Error('invalid_origin')}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('https_origin_required');
 if(url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname==='127.0.0.1')throw new Error('public_https_origin_required');
 return url.origin;
}
export function credentialDomain(origin){
 const host=new URL(normalizeOrigin(origin)).hostname;
 const domain=getDomain(host,{allowPrivateDomains:true});
 if(!domain)throw new Error('unregistrable_domain');
 return domain;
}
function validName(username){return typeof username==='string'&&username.length>0&&username.length<=320&&!/[\r\n\0]/.test(username)}
function bindKey(origin,username){return Buffer.from(origin+'\0'+username,'utf8').toString('base64')}
export class CredentialVault{
 constructor(dataDir,script,protect=null){
  fs.mkdirSync(dataDir,{recursive:true});
  this.db=new DatabaseSync(path.join(dataDir,'credentials.sqlite'));
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS credentials (origin TEXT NOT NULL, username TEXT NOT NULL, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(origin, username))');
  this.script=script;this.protect=protect||createCredentialProtector();
 }
 async save({origin,username,password,replace=false}){
  const site=credentialDomain(origin);
  if(!validName(username)||typeof password!=='string'||!password||password.length>4096||typeof replace!=='boolean')throw new Error('invalid_credentials');
  const existing=this.db.prepare('SELECT 1 FROM credentials WHERE origin=? AND username=?').get(site,username);
  if(existing&&!replace)throw new Error('credential_already_exists_explicit_replace_required');
  const sealed=await this.protect(this.script,'protect',bindKey(site,username),Buffer.from(password,'utf8'));
  const ct=sealed.toString('base64');
  if(existing)this.db.prepare('UPDATE credentials SET ciphertext=?,updated_at=? WHERE origin=? AND username=?').run(ct,Date.now(),site,username);
  else this.db.prepare('INSERT INTO credentials(origin,username,ciphertext,updated_at) VALUES(?,?,?,?)').run(site,username,ct,Date.now());
  return {stored:true,origin:site,username,replaced:!!existing};
 }
 async secret(origin,username){
  const site=credentialDomain(origin);
  if(!validName(username))throw new Error('invalid_username');
  let row=this.db.prepare('SELECT ciphertext FROM credentials WHERE origin=? AND username=?').get(site,username);
  let binding=site;
  // Retain support for exact-origin records written before domain-based storage.
  if(!row){binding=normalizeOrigin(origin);row=this.db.prepare('SELECT ciphertext FROM credentials WHERE origin=? AND username=?').get(binding,username)}
  if(!row)throw new Error('credential_not_found');
  return this.protect(this.script,'unprotect',bindKey(binding,username),Buffer.from(row.ciphertext,'base64'));
 }
 close(){this.db.close()}
}
function validSelector(x){return typeof x==='string'&&x.length>0&&x.length<=256&&!/[\r\n\0]/.test(x)}
export function buildFillCode(origin,username,password,usernameSelector,passwordSelector){
 const site=credentialDomain(origin);
 if(!validName(username)||(!usernameSelector&&!passwordSelector)||(usernameSelector&&!validSelector(usernameSelector))||(passwordSelector&&!validSelector(passwordSelector))||(usernameSelector&&passwordSelector&&usernameSelector===passwordSelector))throw new Error('invalid_fill_target');
 // One in-page execution: origin validation and both writes cannot be separated by a navigation.
 const values={site,username,password,usernameSelector,passwordSelector};
 return `() => {
 const v=${JSON.stringify(values)};
  if(location.protocol!=='https:'||(location.hostname!==v.site&&!location.hostname.endsWith('.'+v.site)))throw new Error('origin_mismatch');
  const pick=(css,type) => {
   const matches=document.querySelectorAll(css);
   if(matches.length!==1)throw new Error('selector_not_unique');
   const field=matches[0];
   if(!(field instanceof HTMLInputElement)||field.disabled||field.readOnly||!field.getClientRects().length)throw new Error('invalid_input');
   if(type==='password'&&field.type!=='password')throw new Error('not_password_field');
   if(type==='username'&&!['text','email'].includes(field.type))throw new Error('not_username_field');
   return field;
  };
  const targets=[];
  if(v.usernameSelector)targets.push([pick(v.usernameSelector,'username'),v.username]);
  if(v.passwordSelector)targets.push([pick(v.passwordSelector,'password'),v.password]);
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  for(const [field,value] of targets) {
   setter.call(field,value);
   field.dispatchEvent(new Event('input',{bubbles:true}));
   field.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return 'HOMEMCP_CREDENTIAL_FILLED';
 }`;
}

export function buildDiagnoseCode(origin,usernameSelector,passwordSelector){
 const site=credentialDomain(origin);
 if(!validSelector(usernameSelector)||!validSelector(passwordSelector))throw new Error('invalid_fill_target');
 const v={site,usernameSelector,passwordSelector};
 return `() => {
 const v=${JSON.stringify(v)};
 const safe=(selector)=>{
  try{
   const matches=[...document.querySelectorAll(selector)];
   return {count:matches.length,types:matches.slice(0,4).map(x=>x instanceof HTMLInputElement?x.type:'non_input')};
  }catch{return {error:'invalid_selector'}}
 };
 return {frames:[{origin:location.origin,hostname:location.hostname,
   matches_site:location.protocol==='https:'&&(location.hostname===v.site||location.hostname.endsWith('.'+v.site)),
   username:safe(v.usernameSelector),password:safe(v.passwordSelector),
   iframe_count:document.querySelectorAll('iframe').length}]};
 }`;
}
export function classifyBrowserFillError(output){
 if(!output||typeof output!=='object')return 'browser_worker_unavailable';
 const body=Array.isArray(output.content)?output.content.filter(x=>x?.type==='text').map(x=>x.text||'').join('\n'):'';
 const result=body.includes('### Result')?body.split('### Result')[1].split('###')[0].trim():'';
 if(!output.isError&&result==='"HOMEMCP_CREDENTIAL_FILLED"')return null;
 // Never search the echoed tool source code for error markers: it contains the
 // literals used by the error branches and will manufacture false positives.
 const reported=body.split('### Ran Playwright code')[0];
 for(const reason of ['origin_mismatch','selector_not_unique','invalid_input','not_password_field','not_username_field','invalid_selector']){
  if(reported.includes(reason))return reason;
 }
 if(/about:blank|No open pages|Target page/.test(reported))return 'browser_page_unavailable';
 return 'browser_execution_unconfirmed';
}
