import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';

/** Direct stdio MCP client. Stdout is protocol-only; stderr is never exposed as a result. */
export class StdioMcpClient extends EventEmitter {
 constructor(spec,{timeoutMs=15000,maxLineBytes=4*1024*1024}={}){
  super();this.spec=spec;this.timeoutMs=timeoutMs;this.maxLineBytes=maxLineBytes;this.id=0;this.pending=new Map();this.buffer='';this.child=null;
 }
 async connect(){
  if(this.child)throw Error('stdio_already_connected');
  const child=spawn(this.spec.command,this.spec.args||[],{cwd:this.spec.cwd||process.cwd(),env:{...process.env,...this.spec.env},stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
  this.child=child;
  child.stdout.on('data',data=>this.receive(data));
  child.stderr.on('data',()=>{}); // Avoid leaking credentials from upstream stderr.
  child.once('exit',()=>this.failAll('stdio_worker_exited'));
  child.once('error',()=>this.failAll('stdio_worker_spawn_failed'));
  try{
   const result=await this.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'homemcp',version:'0.1.0'}});
   await this.request('notifications/initialized',{},true);return result;
  }catch(e){await this.stop();throw e}
 }
 receive(chunk){
  this.buffer+=chunk.toString('utf8');
  if(Buffer.byteLength(this.buffer)>this.maxLineBytes){this.failAll('stdio_response_too_large');this.child?.kill();return}
  let index;
  while((index=this.buffer.indexOf('\n'))>=0){
   const line=this.buffer.slice(0,index).trim();this.buffer=this.buffer.slice(index+1);
   if(!line)continue;
   let message;try{message=JSON.parse(line)}catch{this.failAll('stdio_protocol_error');this.child?.kill();return}
   if(!Object.hasOwn(message,'id'))continue;
   const pending=this.pending.get(message.id);if(!pending)continue;
   this.pending.delete(message.id);clearTimeout(pending.timer);
   if(message.error)pending.reject(Error('upstream_rpc_'+message.error.code));
   else pending.resolve(message.result);
  }
 }
 failAll(reason){
  for(const [,entry] of this.pending){clearTimeout(entry.timer);entry.reject(Error(reason))}
  this.pending.clear();this.emit('unavailable',reason);
 }
 request(method,params,notification=false){
  if(!this.child||this.child.exitCode!==null)return Promise.reject(Error('stdio_worker_unavailable'));
  const id=notification?undefined:++this.id;
  const msg={jsonrpc:'2.0',...(id===undefined?{}:{id}),method,...(params===undefined?{}:{params})};
  if(notification)return new Promise((resolve,reject)=>this.child.stdin.write(JSON.stringify(msg)+'\n',e=>e?reject(e):resolve(null)));
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(method==='tools/call'?'upstream_execution_uncertain':'stdio_request_timeout'))},this.timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   this.child.stdin.write(JSON.stringify(msg)+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(Error('stdio_write_failed'))}});
  });
 }
 async call(name,args){return this.request('tools/call',{name,arguments:args||{}})}
 async list(){return (await this.request('tools/list',{})).tools||[]}
 async stop(){if(!this.child)return;const child=this.child;this.child=null;this.failAll('stdio_worker_stopped');child.kill('SIGTERM')}
}
