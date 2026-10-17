import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
export const rpcResult=(id,result)=>({jsonrpc:'2.0',id,result});
export const tokenEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class Log {
 constructor(dir,name='homemcp',maxBytes=10*1024*1024,maxFiles=5){this.dir=dir;this.file=path.join(dir,`${name}.log`);this.maxBytes=maxBytes;this.maxFiles=maxFiles;fs.mkdirSync(dir,{recursive:true});this.clean();}
 clean(){const prefix=path.basename(this.file);for(const f of fs.readdirSync(this.dir)){if(!f.startsWith(prefix+'.'))continue;const p=path.join(this.dir,f);try{if(Date.now()-fs.statSync(p).mtimeMs>14*86400000)fs.unlinkSync(p);}catch{}}}
 write(level,event,details={}){const line=JSON.stringify({ts:new Date().toISOString(),level,event,...details})+'\n';try{if(fs.existsSync(this.file)&&fs.statSync(this.file).size+Buffer.byteLength(line)>this.maxBytes){for(let n=this.maxFiles-1;n>=1;n--){const from=`${this.file}.${n}`,to=`${this.file}.${n+1}`;if(fs.existsSync(from)){if(n===this.maxFiles-1)fs.unlinkSync(from);else fs.renameSync(from,to);}}fs.renameSync(this.file,`${this.file}.1`);this.clean();}fs.appendFileSync(this.file,line);}catch(e){console.error('log failure',e.message)}}
}
export class McpClient {
 constructor(url,logger,timeoutMs=15000){this.url=url;this.log=logger;this.timeoutMs=timeoutMs;this.session=null;this.id=1;}
 async request(method,params,notification=false){
 const id=notification?undefined:++this.id;const body={jsonrpc:'2.0',method,...(id===undefined?{}:{id}),...(params===undefined?{}:{params})};const headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'};if(this.session)headers['Mcp-Session-Id']=this.session;
 const res=await fetch(this.url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});
 if(res.status===404&&this.session){this.session=null;throw new Error('upstream_session_lost');}
 if(!res.ok)throw new Error(`upstream_http_${res.status}`);const session=res.headers.get('mcp-session-id');if(session)this.session=session;
 if(notification)return null;const ct=res.headers.get('content-type')||'';const bodyText=await res.text();let out;
 if(ct.includes('text/event-stream')){for(const frame of bodyText.replaceAll('\r\n','\n').split('\n\n')){const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(!data)continue;try{const obj=JSON.parse(data);if(obj.id===id){out=obj;break;}}catch{}}}
 else out=JSON.parse(bodyText);
 if(!out)throw new Error('upstream_missing_response');if(out.error)throw new Error(`upstream_rpc_${out.error.code}: ${out.error.message}`);return out.result;
 }
 async connect(){this.session=null;const result=await this.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'homemcp',version:'0.1.0'}});await this.request('notifications/initialized',{},true);return result;}
}
export async function freeLocalPort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p))})});}
async function isPortOpen(url,timeout=350){const u=new URL(url);return new Promise(resolve=>{const s=net.createConnection({host:u.hostname,port:Number(u.port)});let doneFlag=false;const done=x=>{if(doneFlag)return;doneFlag=true;s.destroy();resolve(x)};s.setTimeout(timeout);s.once('connect',()=>done(true));s.once('error',()=>done(false));s.once('timeout',()=>done(false))})}
export async function ownsListener(port,rootPid){
 if(process.platform!=='win32')return true;
 if(!Number.isInteger(rootPid)||rootPid<=0)return false;
 const script=`$ErrorActionPreference='Stop';$p=${port};$root=${rootPid};$owner=(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1 -ExpandProperty OwningProcess);if(-not $owner){exit 3};$seen=@{};for($i=0;$i -lt 24 -and $owner -gt 0;$i++){if($owner -eq $root){Write-Output OWNED;exit 0};if($seen.ContainsKey([string]$owner)){break};$seen[[string]$owner]=$true;$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction Stop;if(-not $proc){break};$owner=[int]$proc.ParentProcessId};exit 4`;
 try{const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:16384});return stdout.trim()==='OWNED'}catch{return false}
}
function setPort(spec,port){const url=new URL(spec.url);url.port=String(port);spec.url=url.toString();const i=(spec.args||[]).findIndex(v=>v==='--port');if(i<0||i===spec.args.length-1)throw new Error('worker_missing_port_argument');spec.args[i+1]=String(port)}
export class Worker {
 constructor(spec,log,onPortChange=async()=>{}){this.spec=spec;this.log=log;this.onPortChange=onPortChange;this.child=null;this.client=null;this.pending=null;this.tools=[];this.status='stopped';this.failures=0;this.retryAfter=0;this.stopping=false;this.owned=false}
 async ensure(){if(this.pending)return this.pending;if(this.child&&this.child.exitCode===null&&this.client&&this.status==='ready'&&this.owned)return this.client;if(Date.now()<this.retryAfter)throw new Error(`worker_${this.spec.name}_backoff`);this.pending=this._ensure().finally(()=>{this.pending=null});return this.pending}
 async _ensure(){this.status='starting';try{
 if(this.child&&(this.child.exitCode!==null||this.child.signalCode!==null))this.child=null;
 if(!this.child){
 for(let i=0;i<8&&await isPortOpen(this.spec.url);i++){const previous=this.spec.url,replacement=await freeLocalPort();setPort(this.spec,replacement);await this.onPortChange(this.spec);this.log.write('warn','worker_port_rebound',{worker:this.spec.name,previousPort:new URL(previous).port,newPort:replacement})}
 if(await isPortOpen(this.spec.url))throw new Error('no_free_worker_port');
 const opts={cwd:this.spec.cwd||process.cwd(),env:{...process.env,...(this.spec.env||{})},windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false};
 const useJobRunner=process.platform==='win32'&&!!process.env.HOMEMCP_JOB_RUNNER;
 const command=useJobRunner?process.env.HOMEMCP_JOB_RUNNER:this.spec.command;
 const args=useJobRunner?['--parent',String(process.pid),'--',this.spec.command,...(this.spec.args||[])]:this.spec.args||[];
 const child=spawn(command,args,opts);this.child=child;this.owned=false;
 child.stdout.on('data',d=>this.log.write('debug','worker_stdout',{worker:this.spec.name,bytes:d.length}));
 child.stderr.on('data',d=>this.log.write('warn','worker_stderr',{worker:this.spec.name,bytes:d.length}));
 child.on('error',e=>{this.log.write('error','worker_spawn_error',{worker:this.spec.name,message:e.message});this.status='stopped';this.client=null;this.owned=false});
 child.on('exit',(code,signal)=>{this.log.write('warn','worker_exit',{worker:this.spec.name,code,signal});if(this.child===child){this.child=null;this.client=null;this.owned=false;this.status='stopped'}});
 this.log.write('info','worker_spawn',{worker:this.spec.name,pid:child.pid});
 }
 const deadline=Date.now()+(this.spec.startupMs||25000);let lastError;
 while(Date.now()<deadline){if(!this.child)throw new Error('worker_exited_during_startup');try{
 if(!await isPortOpen(this.spec.url,250)){await sleep(400);continue}
 if(!await ownsListener(Number(new URL(this.spec.url).port),this.child.pid))throw new Error('listener_not_owned_by_worker');
 const client=new McpClient(this.spec.url,this.log);await client.connect();const result=await client.request('tools/list',{});this.client=client;this.tools=result.tools||[];this.owned=true;this.status='ready';this.failures=0;this.log.write('info','worker_ready',{worker:this.spec.name,count:this.tools.length});return client;
 }catch(e){lastError=e;await sleep(500)}}
 throw new Error(`mcp_not_ready: ${lastError?.message||'timeout'}`);
 }catch(e){this.status='failed';this.client=null;this.owned=false;this.failures++;this.retryAfter=Date.now()+Math.min(60000,1000*2**Math.min(this.failures,6));this.log.write('error','worker_start_failed',{worker:this.spec.name,message:e.message,backoffMs:this.retryAfter-Date.now()});await this.stop();throw e}}
 async call(name,args){const c=await this.ensure();try{return await c.request('tools/call',{name,arguments:args||{}})}catch(e){if(e.message.includes('upstream_session_lost')){this.client=null;this.owned=false;this.status='stopped';this.log.write('warn','session_lost',{worker:this.spec.name})}throw e}}
 async list(){const c=await this.ensure();const result=await c.request('tools/list',{});this.tools=result.tools||[];return this.tools}
 async stop(){this.client=null;this.owned=false;const child=this.child;if(!child){this.status='stopped';return}this.stopping=true;this.status='stopping';
 if(process.platform==='win32'){await new Promise(resolve=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',resolve);killer.once('exit',resolve)})}else{try{child.kill('SIGTERM')}catch{}}
 if(this.child===child)this.child=null;this.stopping=false;this.status='stopped'}
}
