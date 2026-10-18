import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Worker,Log,rpcError,rpcResult,tokenEqual,freeLocalPort} from './core.mjs';
import {EgressManager} from './egress.mjs';
import {ApprovalStore,adminAuthorized,policyFor} from './security.mjs';
import {PasskeyManager} from './passkeys.mjs';
import {CredentialVault,credentialDomain,buildFillCode} from './credentials.mjs';
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
const passkeys=new PasskeyManager(dataDir,{rpID:config.security?.rpID||'localhost',origin:config.security?.rpOrigin||`http://localhost:${port}`});
const policy=config.security?.policy||{};
const credentialVault=config.security?.credentialVaultEnabled===true?new CredentialVault(dataDir,path.join(path.dirname(fileURLToPath(import.meta.url)),'../scripts/credential-dpapi.ps1')):null;
const credentialTools=[
 {name:'credential_save',description:'Encrypt and save a website credential for this Windows user. Explicitly binds HTTPS origin and username. Does not log or return password; overwrite requires replace=true.',inputSchema:{type:'object',properties:{origin:{type:'string'},username:{type:'string'},password:{type:'string'},replace:{type:'boolean'}},required:['origin','username','password'],additionalProperties:false}},
 {name:'credential_fill',description:'Fill saved username/password into explicitly specified CSS input selectors only when the current browser page has the exact saved HTTPS origin. Never returns a password.',inputSchema:{type:'object',properties:{origin:{type:'string'},username:{type:'string'},username_selector:{type:'string'},password_selector:{type:'string'}},required:['origin','username','username_selector','password_selector'],additionalProperties:false}}
];
async function saveConfig(){const tmp=configPath+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(config,null,2),{mode:0o600});fs.renameSync(tmp,configPath);}
const workers=new Map((config.workers||[]).map(w=>[w.name,new Worker(w,log,saveConfig)]));
for(const [name,worker] of workers)worker.spec.env={...(worker.spec.env||{}),HOMEMCP_INSTALLATION_ID:config.installationId||'legacy-dev',HOMEMCP_WORKER_ROLE:name};
const fileDeleteTool={name:'file_delete',description:'Delete one existing regular file after explicit Passkey approval. No directories or symlinks.',inputSchema:{type:'object',properties:{path:{type:'string',description:'Absolute Windows file path'}},required:['path'],additionalProperties:false}};
function validateDeletion(args){
 if(!args||typeof args.path!=='string'||Object.keys(args).some(k=>k!=='path'))throw new Error('invalid_file_delete_arguments');
 const raw=args.path;
 if(!path.win32.isAbsolute(raw)||raw.startsWith('\\\\')||raw.includes('\0')||raw.includes('/')||raw.endsWith('\\'))throw new Error('invalid_absolute_windows_path');
 const full=path.win32.normalize(raw);
 const home=path.win32.normalize(os.homedir());
 const rel=path.win32.relative(home,full);
 if(!rel||rel==='..'||rel.startsWith('..\\')||path.win32.isAbsolute(rel))throw new Error('file_outside_user_home');
 const stat=fs.lstatSync(full);
 if(!stat.isFile()||stat.isSymbolicLink())throw new Error('not_regular_file');
 // A junction or directory symlink inside home must not redirect deletion outside home.
 const canonicalHome=fs.realpathSync.native(home);
 const canonicalFile=fs.realpathSync.native(full);
 const canonicalRel=path.win32.relative(canonicalHome,canonicalFile);
 if(!canonicalRel||canonicalRel==='..'||canonicalRel.startsWith('..\\')||path.win32.isAbsolute(canonicalRel))throw new Error('file_outside_user_home');
 return full;
}
function deleteApprovedFile(args){const full=validateDeletion(args);fs.unlinkSync(full);return {content:[{type:'text',text:'Deleted exactly one file: '+full}],deleted:true,path:full};}
const approvalTools=['approval_status','approval_resume','approval_result','approval_cancel'].map(name=>({name,description:'HomeMCP '+name,inputSchema:{type:'object',properties:{pending_id:{type:'string'},arguments_hash:{type:'string'}},required:['pending_id']}}));
const tools=[...Object.entries(config.tools||{}).map(([name,v])=>({name,description:v.description||`HomeMCP ${name}`,inputSchema:v.inputSchema||{type:'object',properties:{}}})),fileDeleteTool,...(credentialVault?credentialTools:[]),...approvalTools];
function safePreview(name,args){if(name==='file_delete'){try{return 'Delete exactly one regular file: '+validateDeletion(args)}catch{return null}}if(name==='browser_navigate'&&typeof args.url==='string'&&args.url.length<=2048&&/^https?:\/\//i.test(args.url))return 'Navigate browser to '+args.url;return null;}

const maxBody=512*1024;let shutting=false;
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
async function readJSON(req){let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)throw new Error('payload_too_large');}return JSON.parse(body||'{}');}
const originOK=req=>!!req.headers.origin&&req.headers.origin===passkeys.origin;
const server=http.createServer(async(req,res)=>{
 const send=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
 if(req.url==='/health'&&req.method==='GET')return send(200,{ok:!shutting,egress:egress.state,workers:Object.fromEntries([...workers].map(([name,w])=>[name,{status:w.status,childPid:w.child?.pid||null,failures:w.failures}]))});
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
 if(!config.token||!tokenEqual(supplied,config.token))return send(401,{error:'unauthorized'});
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
  if(name==='credential_save'||name==='credential_fill'){
   if(!credentialVault)return send(200,rpcError(msg.id,-32003,'Credential vault not enabled'));
   try{
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('invalid_arguments');
    const expected=name==='credential_save'?['origin','username','password','replace']:['origin','username','username_selector','password_selector'];
    if(Object.keys(args).some(k=>!expected.includes(k)))throw new Error('invalid_arguments');
    if(name==='credential_save'){
     result=await credentialVault.save(args);
    }else{
     const secret=await credentialVault.secret(args.origin,args.username);
     let code;
     try{code=buildFillCode(args.origin,args.username,secret.toString('utf8'),args.username_selector,args.password_selector)}
     finally{secret.fill(0)}
     const browser=workers.get('browser');
     if(!browser)throw new Error('browser_not_configured');
     try{
      const output=await browser.call('browser_run_code',{code});
      const messages=Array.isArray(output?.content)?output.content.filter(item=>item?.type==='text').map(item=>item.text||'').join('\n'):'';
      if(output?.isError||!/(?:^|\n)\s*["']?HOMEMCP_CREDENTIAL_FILLED["']?\s*(?:\n|$)/.test(messages))throw new Error('browser_fill_unconfirmed');
      result={filled:true,domain:credentialDomain(args.origin),username:args.username};
     }catch{throw new Error('browser_fill_failed_or_unconfirmed')}
    }
    security.record('credential_tool_executed',name,null,'ok');
   }catch(e){
    // Never serialize upstream tool errors or original arguments; they may contain credentials.
    security.record('credential_tool_executed',name,null,'failed');
    result={ok:false,error:['credential_already_exists_explicit_replace_required','credential_not_found','invalid_credentials','invalid_arguments','invalid_origin','https_origin_required','public_https_origin_required','invalid_username','invalid_fill_target'].includes(e.message)?e.message:'credential_operation_failed'};
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
