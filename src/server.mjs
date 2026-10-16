import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Worker,Log,rpcError,rpcResult,tokenEqual,freeLocalPort} from './core.mjs';
import {EgressManager} from './egress.mjs';
import {ApprovalStore,adminAuthorized,policyFor} from './security.mjs';
import {PasskeyManager} from './passkeys.mjs';
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
const security=new ApprovalStore(dataDir,{timeoutMs:config.security?.approvalTimeoutMs||120000});
const passkeys=new PasskeyManager(dataDir,{rpID:config.security?.rpID||'localhost',origin:config.security?.rpOrigin||`http://localhost:${port}`});
const policy=config.security?.policy||{};
async function saveConfig(){const tmp=configPath+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(config,null,2),{mode:0o600});fs.renameSync(tmp,configPath);}
const workers=new Map((config.workers||[]).map(w=>[w.name,new Worker(w,log,saveConfig)]));
for(const [name,worker] of workers)worker.spec.env={...(worker.spec.env||{}),HOMEMCP_INSTALLATION_ID:config.installationId||'legacy-dev',HOMEMCP_WORKER_ROLE:name};
const tools=Object.entries(config.tools||{}).map(([name,v])=>({name,description:v.description||`HomeMCP ${name}`,inputSchema:v.inputSchema||{type:'object',properties:{}}}));
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
   if(req.url==='/auth/register/options'){if(!bootstrap)return send(401,{error:'bootstrap_auth_required'});return send(200,await passkeys.registrationOptions());}
   if(req.url==='/auth/register/verify'){if(!bootstrap)return send(401,{error:'bootstrap_auth_required'});const {challengeId,response}=await readJSON(req);return send(200,{verified:await passkeys.verifyRegistration(challengeId,response)});}
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
  if(!passkeys.isSession(cookies(req).homemcp_session))return send(401,{error:'passkey_required'});
  if(req.url==='/approval-api/pending'&&req.method==='GET')return send(200,{pending:security.pending()});
  const match=req.url.match(/^\/approval-api\/([a-f0-9-]{36})\/(approve|reject)$/);
  if(match&&req.method==='POST'){const state=security.complete(match[1],match[2]==='approve'?'approved':'rejected');return state?send(200,{status:state}):send(409,{error:'not_pending_or_expired'});}
  return send(404,{error:'not_found'});
 }
 if(req.url?.startsWith('/admin/')){
  if(!adminAuthorized(req.headers.authorization,config.security?.adminToken))return send(401,{error:'unauthorized'});
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
  const {name,arguments:args={}}=msg.params||{};const map=config.tools?.[name];if(!map)return send(200,rpcError(msg.id,-32602,'Unknown tool'));
  const worker=workers.get(map.worker);if(!worker)return send(200,rpcError(msg.id,-32603,'Worker not configured'));
  const decision=policyFor(name,policy);
  if(decision==='deny'){security.record('tool_denied',name,null,'deny');return send(200,rpcError(msg.id,-32003,'Tool not permitted'));}
  if(decision==='ask'){
   if(name!=='browser_navigate'||typeof args.url!=='string'||args.url.length>2048||!/^https?:\/\//i.test(args.url))return send(200,rpcError(msg.id,-32003,'Approval preview unavailable'));
   const approval=security.create(name,args,`Navigate browser to ${args.url}`);log.write('info','approval_pending',{tool:name,approvalId:approval.id});
   const outcome=await approval.promise;if(outcome!=='approved')return send(200,rpcError(msg.id,-32004,`Approval ${outcome}; id=${approval.id}`));
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
async function shutdown(){if(shutting)return;shutting=true;server.close();security.shutdown();passkeys.close();await Promise.allSettled([egress.stop(),...[...workers.values()].map(w=>w.stop())]);log.write('info','host_stopped');process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
