'use strict';
const byId=id=>document.getElementById(id),status=message=>byId('status').textContent=message;
const decode=str=>Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((str.length+3)%4)),c=>c.charCodeAt(0));
const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function request(path,body,token){const h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;const r=await fetch(path,{method:'POST',headers:h,credentials:'same-origin',body:JSON.stringify(body||{})});const obj=await r.json();if(!r.ok)throw Error(obj.error||r.status);return obj;}
function regOptions(o){return {...o,challenge:decode(o.challenge),user:{...o.user,id:decode(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(c=>({...c,id:decode(c.id)}))};}
function loginOptions(o){return {...o,challenge:decode(o.challenge),allowCredentials:(o.allowCredentials||[]).map(c=>({...c,id:decode(c.id)}))};}
function regJSON(c){return {id:c.id,rawId:encode(c.rawId),type:c.type,response:{clientDataJSON:encode(c.response.clientDataJSON),attestationObject:encode(c.response.attestationObject),transports:c.response.getTransports?.()||[]},clientExtensionResults:c.getClientExtensionResults()};}
function authJSON(c){return {id:c.id,rawId:encode(c.rawId),type:c.type,response:{clientDataJSON:encode(c.response.clientDataJSON),authenticatorData:encode(c.response.authenticatorData),signature:encode(c.response.signature),userHandle:c.response.userHandle?encode(c.response.userHandle):undefined},clientExtensionResults:c.getClientExtensionResults()};}
byId('register').onclick=async()=>{try{const token=byId('bootstrap').value;const invite=new URLSearchParams(location.search).get('enroll');const {challengeId,options}=await request('/auth/register/options',{invite},token);const c=await navigator.credentials.create({publicKey:regOptions(options)});const r=await request('/auth/register/verify',{challengeId,response:regJSON(c),invite},token);byId('bootstrap').value='';status(r.verified?'Passkey registered. Sign in now.':'Registration failed');}catch(e){status('Registration failed: '+e.message)}};
byId('login').onclick=async()=>{try{const {challengeId,options}=await request('/auth/login/options');const c=await navigator.credentials.get({publicKey:loginOptions(options)});await request('/auth/login/verify',{challengeId,response:authJSON(c)});status('Authenticated');await refresh()}catch(e){status('Sign-in failed: '+e.message)}};
byId('refresh').onclick=()=>refresh().catch(e=>status('Cannot load: '+e.message));
byId('logout').onclick=async()=>{await request('/auth/logout');byId('queue').replaceChildren();status('Signed out')};
async function decide(item,decision,button){
 button.disabled=true;
 try{
  const base='/approval-api/'+item.id+'/'+decision;
  const {challengeId,options}=await request(base+'/options');
  const credential=await navigator.credentials.get({publicKey:loginOptions(options)});
  const result=await request(base+'/verify',{challengeId,response:authJSON(credential)});
  status('Decision saved: '+result.status);await refresh();
 }catch(e){status('Decision not recorded: '+e.message);button.disabled=false}
}
async function refresh(){
 const preferred=new URLSearchParams(location.search).get('pending_id');
 const route=preferred?'/approval-api/'+encodeURIComponent(preferred):'/approval-api/pending';
 const r=await fetch(route,{credentials:'same-origin'});
 if(!r.ok)throw Error(preferred?'Request unavailable':'Sign in first to list approvals');
 const body=await r.json(),pending=preferred?[body.request]:body.pending,box=byId('queue');box.replaceChildren();
 for(const item of pending){
  if(preferred&&item.id!==preferred)continue;
  const art=document.createElement('article'),title=document.createElement('h2');title.textContent=item.tool;
  const preview=document.createElement('pre');preview.textContent=item.preview;
  const fingerprint=document.createElement('p');fingerprint.textContent='Request: '+item.id+' | Fingerprint: '+item.arguments_hash.slice(0,16);
  const expiry=document.createElement('p');expiry.textContent='Expires: '+new Date(item.expires_at).toLocaleString();
  art.append(title,preview,fingerprint,expiry);
  for(const decision of ['approve','reject']){const button=document.createElement('button');button.textContent=decision==='approve'?'Approve with Passkey':'Reject with Passkey';button.onclick=()=>decide(item,decision,button);art.append(button)}
  box.append(art);
 }
 if(!box.children.length)status('No pending approvals (or request expired)');
}

if(new URLSearchParams(location.search).has('enroll')){
 byId('enrollment').querySelector('input').hidden=true;
 byId('register').textContent='Register this device Passkey';
 status('One-time enrollment invitation. Create a passkey to bind this phone.');
}
