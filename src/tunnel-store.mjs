import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const appDataRoot=()=>{
 if(process.env.HOMEMCP_HOME)return process.env.HOMEMCP_HOME;
 if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','HomeMCP');
 return path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'HomeMCP');
};
export const dataPath=()=>path.join(appDataRoot(),'data','oracle-tunnel');
const ps=()=>path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const dpapiScript=()=>path.join(projectRoot,'scripts','credential-dpapi.ps1');
const macHelper=()=>process.env.HOMEMCP_MACOS_KEYCHAIN_HELPER||path.join(projectRoot,'native','macos','home-mcp-keychain');
function protect(data,operation){
 const binding=crypto.createHash('sha256').update('HomeMCP Oracle Tunnel Store v1').digest('base64');
 if(process.platform==='darwin'){
  const result=spawnSync(macHelper(),[],{
   input:JSON.stringify({operation,binding,data:data.toString('base64')}),
   encoding:'utf8',timeout:15000,maxBuffer:512*1024,windowsHide:true
  });
  if(result.status!==0)throw Error('macos_keychain_protection_failed');
  try{
   const response=JSON.parse(result.stdout);
   if(typeof response.data!=='string'||!/^[A-Za-z0-9+/=]+$/.test(response.data))throw Error();
   return Buffer.from(response.data,'base64');
  }catch{throw Error('macos_keychain_protection_failed')}
 }
 if(process.platform!=='win32')throw Error('tunnel_secret_store_unavailable');
 const result=spawnSync(ps(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',dpapiScript(),'-Operation',operation,'-Binding',binding],{
  input:data.toString('base64'),encoding:'utf8',maxBuffer:512*1024,windowsHide:true
 });
 if(result.status!==0)throw Error('windows_credential_protection_failed');
 return Buffer.from(result.stdout.trim(),'base64');
}
export function saveSecret(name,record){
 if(!/^[a-z-]+$/.test(name))throw Error('invalid_secret_name');
 const dir=dataPath();fs.mkdirSync(dir,{recursive:true,mode:0o700});if(process.platform!=='win32')fs.chmodSync(dir,0o700);
 const dest=path.join(dir,name+(process.platform==='darwin'?'.keychain':'.dpapi'));
 const temp=dest+'.tmp';
 try{fs.writeFileSync(temp,protect(Buffer.from(JSON.stringify(record)),'protect'),{mode:0o600});fs.renameSync(temp,dest)}
 finally{try{fs.unlinkSync(temp)}catch{}}
}
export function loadSecret(name){
 if(!/^[a-z-]+$/.test(name))throw Error('invalid_secret_name');
 const file=path.join(dataPath(),name+(process.platform==='darwin'?'.keychain':'.dpapi'));
 if(!fs.existsSync(file))return null;
 return JSON.parse(protect(fs.readFileSync(file),'unprotect').toString('utf8'));
}
export function savePublic(name,obj){
 if(!/^[a-z-]+$/.test(name))throw Error('invalid_public_name');
 const dir=dataPath();fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(obj,null,2),{mode:0o600});
}
export function loadPublic(name){
 if(!/^[a-z-]+$/.test(name))throw Error('invalid_public_name');
 try{return JSON.parse(fs.readFileSync(path.join(dataPath(),name+'.json'),'utf8'))}catch{return null}
}
