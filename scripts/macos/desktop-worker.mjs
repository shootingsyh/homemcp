import readline from 'node:readline';
import net from 'node:net';
import os from 'node:os';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const invokeLegacy=(input)=>new Promise((resolve,reject)=>{
 const child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],shell:false});
 let out='',ended=false;
 const stop=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);if(error)reject(error);else resolve(result)};
 const timer=setTimeout(()=>{child.kill('SIGKILL');stop(Error('desktop_helper_timeout'))},20000);
 child.stdout.on('data',data=>{out+=data.toString();if(out.length>24*1024*1024){child.kill('SIGKILL');stop(Error('desktop_helper_output_too_large'))}});
 child.stderr.on('data',()=>{});
 child.on('error',e=>stop(e));
 child.on('close',code=>code===0?stop(null,out):stop(Error('desktop_helper_failed_'+code)));
 child.stdin.end(input);
});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const binary=process.env.HOMEMCP_MAC_DESKTOP_HELPER||path.join(root,'native','macos','home-mcp-desktop');
const socketPath=process.env.HOMEMCP_MAC_DESKTOP_SOCKET || path.join(os.homedir(),'Library','Application Support','HomeMCP','desktop.sock');
const invokeSocket=input=>new Promise((resolve,reject)=>{
 let out='',done=false;
 const socket=net.createConnection(socketPath);
 const timer=setTimeout(()=>{socket.destroy();finish(Error('desktop_service_timeout'))},25000);
 function finish(error,value){if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value)}
 socket.on('connect',()=>socket.end(input+String.fromCharCode(10)));
 socket.on('data',d=>{out+=d.toString('utf8');if(out.length>24*1024*1024){socket.destroy();finish(Error('desktop_service_output_too_large'))}});
 socket.on('end',()=>finish(null,out));
 socket.on('error',e=>finish(Error('desktop_service_unavailable: '+e.code)));
});
const invoke=input=>process.env.HOMEMCP_MAC_DESKTOP_LEGACY==='1'?invokeLegacy(input):invokeSocket(input);
const definitions=[
 ['desktop_permissions','Report native helper permissions',{}],
 ['desktop_screenshot','Capture the primary Mac display',{ }],
 ['desktop_snapshot','Describe focused macOS application and window',{}],
 ['desktop_click','Click at a global display coordinate',{x:{type:'number'},y:{type:'number'}}],
 ['desktop_type','Type Unicode text in focused application',{text:{type:'string'}}],
 ['desktop_scroll','Scroll in focused application',{lines:{type:'integer'}}],
 ['desktop_shortcut','Send a macOS keycode with optional modifiers',{keycode:{type:'integer'},modifiers:{type:'array',items:{type:'string'}}}]
];
const tools=definitions.map(([name,description,properties])=>({name,description,inputSchema:{type:'object',properties,additionalProperties:false,...(['desktop_click','desktop_type','desktop_scroll','desktop_shortcut'].includes(name)?{required:Object.keys(properties).filter(k=>k!=='modifiers')}:{} )}}));
function reply(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n')}
function error(id,message){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message}})+'\n')}
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 let request;try{request=JSON.parse(line)}catch{continue}
 if(!Object.hasOwn(request,'id'))continue;
 try{
  if(request.method==='initialize')reply(request.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'homemcp-mac-desktop',version:'1.0.0'}});
  else if(request.method==='tools/list')reply(request.id,{tools});
  else if(request.method==='tools/call'){
   const name=request.params?.name;
   if(!definitions.some(d=>d[0]===name))throw Error('unknown_tool');
   const input=JSON.stringify({tool:name,arguments:request.params?.arguments||{}});
   const result=JSON.parse(await invoke(input));
   if(result.error)throw Error([result.error,result.permission_subject?`Process: ${result.permission_subject}`:'',result.next_step||''].filter(Boolean).join(' — '));
   if(name==='desktop_screenshot'&&result.image_base64){
    reply(request.id,{content:[{type:'image',mimeType:'image/png',data:result.image_base64}],structuredContent:{width:result.width,height:result.height,mime_type:'image/png'}});
   }else reply(request.id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
  }else error(request.id,'method_not_found');
 }catch(e){error(request.id,String(e.message||e))}
}
