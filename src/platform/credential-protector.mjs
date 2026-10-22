import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Buffer in/out interface: (script, operation, binding, plaintextOrCiphertext) => Buffer.
// Existing encrypted Windows records retain their exact DPAPI binding and ciphertext.
function invoke(command,args,input,{timeout=15000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','ignore'],timeout});
  let output='',finished=false;
  const fail=()=>{if(finished)return;finished=true;reject(new Error('credential_protection_failed'))};
  child.stdout.on('data',chunk=>{
   output+=chunk.toString('utf8');
   if(output.length>131072){child.kill();fail()}
  });
  child.on('error',fail);
  child.on('close',code=>{
   if(finished)return;
   finished=true;
   if(code!==0||!/^[A-Za-z0-9+/=]+$/.test(output))return reject(new Error('credential_protection_failed'));
   resolve(Buffer.from(output,'base64'));
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(input,'utf8');
 });
}
export function createCredentialProtector(platform=process.platform){
 if(platform==='win32')return async(script,operation,binding,secret)=>{
  return invoke('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Operation',operation,'-Binding',binding],secret.toString('base64'));
 };
 if(platform==='darwin')return async(_script,operation,binding,secret)=>{
  if(!['protect','unprotect'].includes(operation))throw new Error('invalid_protection_operation');
  const helper=process.env.HOMEMCP_MACOS_KEYCHAIN_HELPER||
   path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../native/macos/home-mcp-keychain');
  // Secret and binding are sent only via stdin; stdout emits a base64-encoded
  // opaque Keychain reference (protect) or plaintext (unprotect).
  return await new Promise((resolve,reject)=>{
   const child=spawn(helper,[],{stdio:['pipe','pipe','ignore'],timeout:15000});
   let response='',finished=false;
   const fail=()=>{if(!finished){finished=true;reject(new Error('credential_protection_failed'))}};
   child.on('error',fail);
   child.stdout.on('data',d=>{response+=d.toString('utf8');if(response.length>131072){child.kill();fail()}});
   child.on('close',code=>{
    if(finished)return;
    finished=true;
    try{
     const result=JSON.parse(response);
     if(code!==0||!result?.data||!/^[A-Za-z0-9+/=]+$/.test(result.data))throw Error();
     resolve(Buffer.from(result.data,'base64'));
    }catch{reject(new Error('credential_protection_failed'))}
   });
   child.stdin.on('error',()=>{});
   child.stdin.end(JSON.stringify({operation,binding,data:secret.toString('base64')}));
  });
 };
 throw new Error('credential_protector_not_available');
}
