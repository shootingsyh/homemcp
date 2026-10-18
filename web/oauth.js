'use strict';
const params=new URLSearchParams(location.search),byId=x=>document.getElementById(x),status=x=>byId('status').textContent=x;
byId('client').textContent=params.get('client_id')||'';
byId('redirect').textContent=params.get('redirect_uri')||'';
const dec=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
const enc=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});const x=await r.json();if(!r.ok)throw Error(x.error||r.status);return x}
byId('login').onclick=async()=>{try{const {challengeId,options}=await post('/auth/login/options',{});const o={...options,challenge:dec(options.challenge),allowCredentials:(options.allowCredentials||[]).map(c=>({...c,id:dec(c.id)}))};const c=await navigator.credentials.get({publicKey:o});const response={id:c.id,rawId:enc(c.rawId),type:c.type,response:{clientDataJSON:enc(c.response.clientDataJSON),authenticatorData:enc(c.response.authenticatorData),signature:enc(c.response.signature),userHandle:c.response.userHandle?enc(c.response.userHandle):undefined},clientExtensionResults:c.getClientExtensionResults()};await post('/auth/login/verify',{challengeId,response});status('Signed in. Review the client and choose Allow.')}catch(e){status('Passkey sign-in failed: '+e.message)}};
byId('approve').onclick=async()=>{try{const r=await post('/oauth/consent',{request:location.search.slice(1),approve:true});location.assign(r.redirect)}catch(e){status('Approval failed: '+e.message)}};
byId('deny').onclick=()=>{status('Cancelled. You can close this window.')};
