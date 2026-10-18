import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function normalizeOrigin(raw){
 if(typeof raw!=='string'||raw.length>512)throw new Error('invalid_origin');
 let url;
 try{url=new URL(raw)}catch{throw new Error('invalid_origin')}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('https_origin_required');
 if(url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname==='127.0.0.1')throw new Error('public_https_origin_required');
 return url.origin;
}
function validName(username){return typeof username==='string'&&username.length>0&&username.length<=320&&!/[\r\n\0]/.test(username)}
function bindKey(origin,username){return Buffer.from(origin+'\0'+username,'utf8').toString('base64')}
async function dpapi(script,operation,binding,secret){
 if(process.platform!=='win32')throw new Error('windows_dpapi_required');
 return await new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Operation',operation,'-Binding',binding],{windowsHide:true,timeout:15000,stdio:['pipe','pipe','ignore']});
  let output='',failed=false;
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>131072){failed=true;child.kill()}});
  child.on('error',()=>reject(new Error('credential_protection_unavailable')));
  child.on('close',code=>{if(code!==0||failed||!/^[A-Za-z0-9+/=]+$/.test(output))return reject(new Error('credential_protection_failed'));resolve(Buffer.from(output,'base64'))});
  child.stdin.on('error',()=>{});
  child.stdin.end(Buffer.from(secret).toString('base64'),'ascii');
 });
}
export class CredentialVault{
 constructor(dataDir,script,protect=dpapi){
  fs.mkdirSync(dataDir,{recursive:true});
  this.db=new DatabaseSync(path.join(dataDir,'credentials.sqlite'));
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS credentials (origin TEXT NOT NULL, username TEXT NOT NULL, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(origin, username))');
  this.script=script;this.protect=protect;
 }
 async save({origin,username,password,replace=false}){
  const site=normalizeOrigin(origin);
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
  const site=normalizeOrigin(origin);
  if(!validName(username))throw new Error('invalid_username');
  const row=this.db.prepare('SELECT ciphertext FROM credentials WHERE origin=? AND username=?').get(site,username);
  if(!row)throw new Error('credential_not_found');
  return this.protect(this.script,'unprotect',bindKey(site,username),Buffer.from(row.ciphertext,'base64'));
 }
 close(){this.db.close()}
}
function validSelector(x){return typeof x==='string'&&x.length>0&&x.length<=256&&!/[\r\n\0]/.test(x)}
export function buildFillCode(origin,username,password,usernameSelector,passwordSelector){
 const site=normalizeOrigin(origin);
 if(!validName(username)||!validSelector(usernameSelector)||!validSelector(passwordSelector)||usernameSelector===passwordSelector)throw new Error('invalid_fill_target');
 // One in-page execution: origin validation and both writes cannot be separated by a navigation.
 const values={site,username,password,usernameSelector,passwordSelector};
 return `return await page.evaluate((v) => {
  if(location.origin!==v.site)throw new Error('origin_mismatch');
  const pick=(css,type) => {
   const matches=document.querySelectorAll(css);
   if(matches.length!==1)throw new Error('selector_not_unique');
   const field=matches[0];
   if(!(field instanceof HTMLInputElement)||field.disabled||field.readOnly||!field.getClientRects().length)throw new Error('invalid_input');
   if(type==='password'&&field.type!=='password')throw new Error('not_password_field');
   if(type==='username'&&!['text','email'].includes(field.type))throw new Error('not_username_field');
   return field;
  };
  const u=pick(v.usernameSelector,'username'),p=pick(v.passwordSelector,'password');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  for(const [field,value] of [[u,v.username],[p,v.password]]) {
   setter.call(field,value);
   field.dispatchEvent(new Event('input',{bubbles:true}));
   field.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return 'HOMEMCP_CREDENTIAL_FILLED';
 },${JSON.stringify(values)});`;
}
