import {validateDeletionPath} from './platform/file-security.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Worker,Log,rpcError,rpcResult,tokenEqual,freeLocalPort} from './core.mjs';
import {EgressManager} from './egress.mjs';
import {ApprovalStore,adminAuthorized,policyFor} from './security.mjs';
import {PasskeyManager} from './passkeys.mjs';
import {HomeOAuth} from './oauth.mjs';
import {CredentialVault,credentialDomain,buildFillCode,buildDiagnoseCode,classifyBrowserFillError} from './credentials.mjs';
const idx=process.argv.indexOf('--config');
const configPath=idx>=0?process.argv[idx+1]:process.env.HOMEMCP_CONFIG;
if(!configPath)throw new Error('Use --config <path>');
const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
if(config.host&&!['127.0.0.1','::1','localhost'].includes(config.host))throw new Error('Remote binding disabled in prototype');
const host='127.0.0.1';let port=config.port;
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('A valid installed host port is required');
const dataDir=config.dataDir||path.join(os.homedir(),'.homemcp');
const log=new Log(path.join(dataDir,'logs'));
if(config.egress?.enabled)throw new Error('Remote egress disabled while security/HITL remains development-only');
const egress=new EgressManager(config.egress,log,dataDir);
const security=new ApprovalStore(dataDir,{timeoutMs:config.security?.approvalTimeoutMs||600000});
const configuredOrigin=config.publicUrl||config.security?.rpOrigin||`http://localhost:${port}`;
const passkeys=new PasskeyManager(dataDir,{rpID:config.security?.rpID||new URL(configuredOrigin).hostname,origin:configuredOrigin});
const policy=config.security?.policy||{};
// A single per-installation HTTPS origin is used for both passkeys and OAuth.
// Never infer issuer from request Host / Forwarded headers controlled by callers.
const publicUrl=config.publicUrl||config.oauth?.issuer||config.security?.rpOrigin||null;
if(publicUrl&&config.security?.rpOrigin&&new URL(publicUrl).origin!==new URL(config.security.rpOrigin).origin)throw new Error('public_url_passkey_origin_mismatch');
const oauth=publicUrl?.startsWith('https://')&&config.oauth?.enabled!==false?new HomeOAuth(dataDir,publicUrl):null;
const credentialVault=config.security?.credentialVaultEnabled===true?new CredentialVault(dataDir,path.join(path.dirname(fileURLToPath(import.meta.url)),'../scripts/credential-dpapi.ps1')):null;
const credentialTools=[
 {name:'credential_save',description:'Encrypt and save a website credential for this Windows user. Explicitly binds HTTPS origin and username. Does not log or return password; overwrite requires replace=true.',inputSchema:{type:'object',properties:{origin:{type:'string'},username:{type:'string'},password:{type:'string'},replace:{type:'boolean'}},required:['origin','username','password'],additionalProperties:false}},
 {name:'credential_diagnose',description:'Inspect browser frame origins and CSS selector matches without accessing saved passwords.',inputSchema:{type:'object',properties:{origin:{type:'string'},username_selector:{type:'string'},password_selector:{type:'string'}},required:['origin','username_selector','password_selector'],additionalProperties:false}},
 {name:'credential_fill',description:'Fill a saved credential into current HTTPS page. CSS selectors can target username and password together, or provide one selector for multi-step login (email then password). Never returns the password.',inputSchema:{type:'object',properties:{origin:{type:'string'},username:{type:'string'},username_selector:{type:'string'},password_selector:{type:'string'}},required:['origin','username'],additionalProperties:false}}
];
async function saveConfig(){const tmp=configPath+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(config,null,2),{mode:0o600});fs.renameSync(tmp,configPath);}
const workers=new Map((config.workers||[]).map(w=>[w.name,new Worker(w,log,saveConfig)]));
for(const [name,worker] of workers)worker.spec.env={...(worker.spec.env||{}),HOMEMCP_INSTALLATION_ID:config.installationId||'legacy-dev',HOMEMCP_WORKER_ROLE:name};
const fileDeleteTool={name:'file_delete',description:'Delete one existing regular file after explicit Passkey approval. No directories or symlinks. Path is platform-native.',inputSchema:{type:'object',properties:{path:{type:'string',description:'Absolute path inside the current user home directory'}},required:['path'],additionalProperties:false}};
function validateDeletion(args){
 if(!args||typeof args.path!=='string'||Object.keys(args).some(k=>k!=='path'))throw new Error('invalid_file_delete_arguments');
 return validateDeletionPath(args.path);
}
function deleteApprovedFile(args){const full=validateDeletion(args);fs.unlinkSync(full);return {content:[{type:'text',text:'Deleted exactly one file: '+full}],deleted:true,path:full};}
const approvalTools=['approval_status','approval_resume','approval_result','approval_cancel'].map(name=>({name,description:'HomeMCP '+name,inputSchema:{type:'object',properties:{pending_id:{type:'string'},arguments_hash:{type:'string'}},required:['pending_id']}}));
const tools=[...Object.entries(config.tools||{}).map(([name,v])=>({name,description:v.description||`HomeMCP ${name}`,inputSchema:v.inputSchema||{type:'object',properties:{}}})),fileDeleteTool,...(credentialVault?credentialTools:[]),...approvalTools];
function safePreview(name,args){if(name==='file_delete'){try{return 'Delete exactly one regular file: '+validateDeletion(args)}catch{return null}}if(name==='browser_navigate'&&typeof args.url==='string'&&args.url.length<=2048&&/^https?:\/\//i.test(args.url))return 'Navigate browser to '+args.url;
 if(name==='desktop_PowerShell'&&args&&typeof args.command==='string'&&args.command.length>0&&args.command.length<=4000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(args.command)&&Object.keys(args).every(k=>['command','timeout'].includes(k))&&(!('timeout' in args)||(Number.isInteger(args.timeout)&&args.timeout>=1&&args.timeout<=120)))return 'PowerShell command (approve exact text):\n'+args.command;
 if(name==='desktop_App'&&args&&typeof args==='object'&&!Array.isArray(args)){const t=JSON.stringify(args);if(t.length<=2000&&Object.keys(args).every(k=>['mode','name','window_loc','window_size','executable','args','cwd'].includes(k)))return 'Desktop application action (approve exact arguments): '+t;}
 return null;}

const maxBody=512*1024;let shutting=false;
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
async function readJSON(req){let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)throw new Error('payload_too_large');}return JSON.parse(body||'{}');}
const originOK=req=>!!req.headers.origin&&req.headers.origin===passkeys.origin;
const server=http.createServer(async(req,res)=>{
 const send=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
 if(req.url==='/health'&&req.method==='GET')return send(200,{ok:!shutting,egress:egress.state,workers:Object.fromEntries([...workers].map(([name,w])=>[name,{status:w.status,childPid:w.child?.pid||null,failures:w.failures}]))});
 const route=new URL(req.url||'/', 'http://localhost');
 const pathname=route.pathname;
 if(oauth){
  if(req.method==='GET'&&(pathname==='/.well-known/oauth-protected-resource'||pathname==='/.well-known/oauth-protected-resource/mcp'))return send(200,oauth.protectedMetadata());
  if(req.method==='GET'&&['/.well-known/oauth-authorization-server','/.well-known/openid-configuration'].includes(pathname))return send(200,oauth.metadata());
  if(req.method==='GET'&&pathname==='/authorize'){
   try{oauth.validateAuth(route.searchParams)}catch(e){return send(400,{error:e.message})}
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",'X-Content-Type-Options':'nosniff'});
   return res.end(fs.readFileSync(new URL('../web/oauth.html',import.meta.url)));
  }
  if(req.method==='GET'&&pathname==='/oauth.js'){res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(fs.readFileSync(new URL('../web/oauth.js',import.meta.url)))}
  if(req.method==='POST'&&pathname==='/register'){
   let body;try{body=await readJSON(req);return send(201,oauth.register(body))}catch(e){return send(400,{error:e.message})}
  }
  if(req.method==='POST'&&pathname==='/oauth/consent'){
   if(!passkeys.isSession(cookies(req).homemcp_session))return send(401,{error:'passkey_login_required'});
   if(req.headers.origin!==oauth.issuer)return send(403,{error:'invalid_origin'});
   try{const body=await readJSON(req);if(body.approve!==true||typeof body.request!=='string'||body.request.length>8192)throw Error('invalid_request');const auth=oauth.validateAuth(new URLSearchParams(body.request));const code=oauth.issueCode(auth);const redirect=new URL(auth.redirect);redirect.searchParams.set('code',code);if(auth.state)redirect.searchParams.set('state',auth.state);return send(200,{redirect:redirect.toString()})}catch(e){return send(400,{error:e.message})}
  }
  if(req.method==='POST'&&['/token','/revoke'].includes(pathname)){
   let input='';for await(const chunk of req){input+=chunk;if(input.length>8192)return send(413,{error:'too_large'})}
   try{const form=new URLSearchParams(input);if(pathname==='/token')return send(200,oauth.exchange(form));oauth.revoke(form.get('token'),form.get('client_id'));return send(200,{})}catch(e){return send(400,{error:e.message})}
  }
 }
 if(req.url?.startsWith('/auth/')){
  if(req.method!=='POST'||!originOK(req))return send(403,{error:'invalid_origin'});
  const bootstrap=adminAuthorized(req.headers.authorization,config.security?.adminToken);const session=cookies(req).homemcp_session;
  try{
   if(req.url==='/auth/register/options'){const {invite}=await readJSON(req);if(!bootstrap&&!passkeys.validInvite(invite))return send(401,{error:'enrollment_invite_required'});return send(200,await passkeys.registrationOptions(bootstrap?null:invite));}
   if(req.url==='/auth/register/verify'){const {challengeId,response,invite}=await readJSON(req);if(!bootstrap&&!passkeys.validInvite(invite))return send(401,{error:'enrollment_invite_required'});return send(200,{verified:await passkeys.verifyRegistration(challengeId,response,bootstrap?null:invite)});}
   if(req.url==='/auth/login/options')return send(200,await passkeys.authenticationOptions());
   if(req.url==='/auth/login/verify'){const {challengeId,response}=await readJSON(req);const token=await passkeys.verifyAuthentication(challengeId,response);if(!token)return send(401,{error:'verification_failed'});res.setHeader('Set-Cookie',`homemcp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`);return send(200,{authenticated:true});}
   if(req.url==='/auth/logout'){passkeys.logout(session);res.setHeader('Set-Cookie','homemcp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{authenticated:false});}
  }catch(e){log.write('warn','passkey_failure',{error:e.message});return send(400,{error:'webauthn_failed'});}
  return send(404,{error:'not_found'});
 }
 if(req.url==='/approval'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'"});return res.end(fs.readFileSync(new URL('../web/approval.html',import.meta.url)));}
 if(req.url==='/approval.js'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(fs.readFileSync(new URL('../web/approval.js',import.meta.url)));}
 if(req.url?.startsWith('/approval-api/')){
  if(req.method!=='GET'&&!originOK(req))return send(403,{error:'invalid_origin'});
  const one=req.url.match(/^\/approval-api\/([a-f0-9-]{36})$/);
  if(one&&req.method==='GET'){
   const item=security.get(one[1]);return item?send(200,{request:item}):send(404,{error:'not_found'});
  }
  const opts=req.url.match(/^\/approval-api\/([a-f0-9-]{36})\/(approve|reject)\/options$/);
  if(opts&&req.method==='POST'){
   if(security.get(opts[1])?.status!=='pending')return send(409,{error:'not_pending'});
   try{return send(200,await passkeys.decisionOptions(opts[1],opts[2]));}
   catch(e){log.write('warn','approval_options_error',{message:e.message});return send(400,{error:'passkey_unavailable'});}
  }
  const verify=req.url.match(/^\/approval-api\/([a-f0-9-]{36})\/(approve|reject)\/verify$/);
  if(verify&&req.method==='POST'){
   try{
    const {challengeId,response}=await readJSON(req);
    if(!await passkeys.verifyDecision(challengeId,response,verify[1],verify[2]))return send(401,{error:'verification_failed'});
    const value=security.complete(verify[1],verify[2]==='approve'?'approved':'rejected');
    return value?send(200,{status:value}):send(409,{error:'not_pending'});
   }catch(e){log.write('warn','approval_verify_error',{message:e.message});return send(400,{error:'webauthn_failed'});}
  }
  if(!passkeys.isSession(cookies(req).homemcp_session))return send(401,{error:'passkey_required'});
  if(req.url==='/approval-api/pending'&&req.method==='GET')return send(200,{pending:security.pending()});
  return send(404,{error:'not_found'});
 }
 if(req.url?.startsWith('/admin/')){
  if(!adminAuthorized(req.headers.authorization,config.security?.adminToken))return send(401,{error:'unauthorized'});
  if(req.url==='/admin/enrollment'&&req.method==='POST'){
   const invitation=passkeys.issueEnrollmentInvite();
   const base=config.security?.rpOrigin||`http://localhost:${port}`;
   return send(200,{url:base+'/approval?enroll='+encodeURIComponent(invitation.token),expires_at:invitation.expires_at});
  }
  if(req.method==='POST')return send(403,{error:'passkey_required_use_approval_api'});
  if(req.url==='/admin/approvals'&&req.method==='GET')return send(200,{pending:security.pending()});
  return send(404,{error:'not_found'});
 }
 if(req.url!=='/mcp'||req.method!=='POST')return send(404,{error:'not_found'});
 const supplied=(req.headers.authorization||'').match(/^Bearer (.+)$/i)?.[1];
 if(!((config.token&&tokenEqual(supplied,config.token))||(oauth&&oauth.authorized(supplied)))){if(oauth)res.setHeader('WWW-Authenticate',`Bearer resource_metadata=\"${oauth.issuer}/.well-known/oauth-protected-resource\"`);return send(401,{error:'unauthorized'});}
 let buffer='';for await(const chunk of req){buffer+=chunk;if(Buffer.byteLength(buffer)>maxBody)return send(413,{error:'too_large'});}
 let msg;try{msg=JSON.parse(buffer);}catch{return send(400,{error:'bad_json'});}
 if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string')return send(400,{error:'invalid_request'});
 if(msg.id===undefined){res.writeHead(202);res.end();return;}
 let result;try{
 switch(msg.method){
 case 'initialize':result={protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'homemcp',version:'0.1.0'}};break;
 case 'ping':result={};break;
 case 'tools/list':result={tools};break;
 case 'tools/call':{
  const {name,arguments:args={}}=msg.params||{};
  if(['approval_status','approval_result','approval_cancel','approval_resume'].includes(name)){
   const id=args.pending_id,known=security.get(id);
   if(!known)return send(200,rpcError(msg.id,-32602,'Unknown approval ID'));
   if(name==='approval_status'){result=known;break;}
   if(name==='approval_result'){result=security.result(id);break;}
   if(name==='approval_cancel'){result={status:security.cancel(id)||known.status};break;}
   const claimed=security.claim(id,args.arguments_hash);
   if(!claimed){result={...security.result(id),message:'Not approved or already claimed; query approval_result for outcome'};break;}
   if(claimed.tool==='file_delete'){
    try{const output=deleteApprovedFile(claimed.args);security.finish(id,output,null);}
    catch(e){security.finish(id,null,e.message);}
    result=security.result(id);break;
   }
   const original=config.tools?.[claimed.tool];const w=workers.get(original?.worker);
   if(!w){security.finish(id,null,'worker_not_configured');result=security.result(id);break;}
   try{const output=await w.call(original.upstream,claimed.args);security.finish(id,output,null);}
   catch(e){security.finish(id,null,e.message);}
   result=security.result(id);break;
  }
  if(name==='credential_save'||name==='credential_fill'||name==='credential_diagnose'){
   if(!credentialVault)return send(200,rpcError(msg.id,-32003,'Credential vault not enabled'));
   try{
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('invalid_arguments');
    const expected=name==='credential_save'?['origin','username','password','replace']:name==='credential_diagnose'?['origin','username_selector','password_selector']:['origin','username','username_selector','password_selector'];
    if(Object.keys(args).some(k=>!expected.includes(k)))throw new Error('invalid_arguments');
    if(name==='credential_save'){
     result=await credentialVault.save(args);
    }else if(name==='credential_diagnose'){
     const browser=workers.get('browser');
     if(!browser)throw new Error('browser_not_configured');
     const output=await browser.call('browser_evaluate',{function:buildDiagnoseCode(args.origin,args.username_selector,args.password_selector)});
     if(output?.isError)throw new Error('browser_inspection_unavailable');
     const text=Array.isArray(output?.content)?output.content.filter(x=>x?.type==='text').map(x=>x.text||'').join('\n'):'';
     let diagnostic=null;
     const marker=text.indexOf('### Result');
     if(marker>=0){
      const fragment=text.slice(marker+'### Result'.length).split('###')[0].trim();
      try{const parsed=JSON.parse(fragment);if(parsed?.frames)diagnostic=parsed}catch{}
     }
     if(!diagnostic)throw new Error('browser_inspection_unavailable');
     result={ok:true,...diagnostic};
    }else{
     const secret=await credentialVault.secret(args.origin,args.username);
     let code;
     try{code=buildFillCode(args.origin,args.username,secret.toString('utf8'),args.username_selector,args.password_selector)}
     finally{secret.fill(0)}
     const browser=workers.get('browser');
     if(!browser)throw new Error('browser_not_configured');
     try{
      const output=await browser.call('browser_evaluate',{function:code});
      const reason=classifyBrowserFillError(output);
      if(reason)throw new Error(reason);
      result={filled:true,domain:credentialDomain(args.origin),username:args.username,fields:[...(args.username_selector?['username']:[]),...(args.password_selector?['password']:[])]};
     }catch(e){throw new Error(['origin_mismatch','selector_not_unique','invalid_input','not_password_field','not_username_field','invalid_selector','browser_page_unavailable','browser_execution_unconfirmed'].includes(e.message)?e.message:'browser_fill_failed_or_unconfirmed')}
    }
    security.record('credential_tool_executed',name,null,'ok');
   }catch(e){
    // Never serialize upstream tool errors or original arguments; they may contain credentials.
    security.record('credential_tool_executed',name,null,'failed');
    result={ok:false,error:['credential_already_exists_explicit_replace_required','credential_not_found','invalid_credentials','invalid_arguments','invalid_origin','https_origin_required','public_https_origin_required','invalid_username','invalid_fill_target','origin_mismatch','selector_not_unique','invalid_input','not_password_field','not_username_field','invalid_selector','browser_page_unavailable','browser_execution_unconfirmed','browser_inspection_unavailable'].includes(e.message)?e.message:'credential_operation_failed'};
   }
   break;
  }
  if(name==='file_delete'){
   const preview=safePreview(name,args);
   if(!preview)return send(200,rpcError(msg.id,-32602,'File must be an existing regular file inside the Windows user home directory'));
   const approval=security.create(name,args,preview,msg.params?.idempotency_key||null);
   result={status:'approval_required',pending_id:approval.id,tool:name,summary:preview,arguments_hash:approval.arguments_hash,expires_at:approval.expires_at,approval_url:'/approval?pending_id='+approval.id};
   break;
  }
  const map=config.tools?.[name];if(!map)return send(200,rpcError(msg.id,-32602,'Unknown tool'));
  const worker=workers.get(map.worker);if(!worker)return send(200,rpcError(msg.id,-32603,'Worker not configured'));
  const decision=policyFor(name,policy);
  if(decision==='deny'){security.record('tool_denied',name,null,'deny');return send(200,rpcError(msg.id,-32003,'Tool not permitted'));}
  if(decision==='ask'){
   const preview=safePreview(name,args);
   if(!preview)return send(200,rpcError(msg.id,-32003,'Approval preview unavailable'));
   const approval=security.create(name,args,preview,msg.params?.idempotency_key||null);
   result={status:'approval_required',pending_id:approval.id,tool:name,summary:preview,arguments_hash:approval.arguments_hash,expires_at:approval.expires_at,approval_url:'/approval?pending_id='+approval.id};
   break;
  }
  log.write('info','tool_call',{tool:name,worker:map.worker});
  const upstream=await worker.call(map.upstream,args);security.record('tool_executed',name,null,'ok');result=upstream;break;
 }
 default:return send(200,rpcError(msg.id,-32601,'Method not found'));
 }
 return send(200,rpcResult(msg.id,result));
 }catch(e){log.write('error','tool_failure',{method:msg.method,tool:msg.params?.name,error:e.message});return send(200,rpcError(msg.id,-32603,e.message));}
});
server.on('error',async e=>{
 if(e.code==='EADDRINUSE'){try{const prev=port;port=await freeLocalPort();config.port=port;if(!config.security?.rpOrigin)passkeys.origin=`http://localhost:${port}`;await saveConfig();log.write('warn','host_port_rebound',{previousPort:prev,newPort:port});server.listen(port,host);return;}catch(err){console.error('Host rebinding failed',err);}}
 log.write('error','host_bind_failed',{code:e.code,port});process.exitCode=1;
});
server.on('listening',()=>{log.write('info','host_listening',{host,port});console.log(`HomeMCP ready at http://${host}:${port}/mcp`);egress.start(port).catch(e=>log.write('error','egress_start_failed',{message:e.message}));});
server.listen(port,host);
async function shutdown(){if(shutting)return;shutting=true;server.close();security.shutdown();passkeys.close();credentialVault?.close();await Promise.allSettled([egress.stop(),...[...workers.values()].map(w=>w.stop())]);log.write('info','host_stopped');process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
