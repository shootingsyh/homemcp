import readline from 'node:readline';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const binary=process.env.HOMEMCP_MAC_DESKTOP_HELPER||path.join(root,'native','macos','home-mcp-desktop');
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
   const {stdout}=await run(binary,[],{input,timeout:20000,maxBuffer:24*1024*1024});
   const result=JSON.parse(stdout);
   if(result.error)throw Error(result.error);
   reply(request.id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
  }else error(request.id,'method_not_found');
 }catch(e){error(request.id,String(e.message||e))}
}
