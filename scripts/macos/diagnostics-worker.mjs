#!/usr/bin/env node
// Native macOS diagnostics and command worker. stdio MCP, no extra dependencies.
// All tool execution is authorized by the shared Host allow/ask/deny policy. Mac shell defaults to allow, matching Windows PowerShell; users can change this policy.
import os from 'node:os';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import readline from 'node:readline';
import {promisify} from 'node:util';
const run=promisify(execFile);
if(process.platform!=='darwin' && process.env.HOMEMCP_TEST_MAC_TOOLS!=='1')process.exit(2);
const spec=[
 {name:'system_usage',description:'Read CPU load, memory and uptime from this Mac.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'system_processes',description:'List top macOS processes by CPU or memory usage (read only).',inputSchema:{type:'object',properties:{sort:{type:'string',enum:['cpu','memory']},limit:{type:'integer',minimum:1,maximum:50}},additionalProperties:false}},
 {name:'shell_execute',description:'Execute a shell command on this Mac. REQUIRES explicit HomeMCP Passkey approval before every invocation.',inputSchema:{type:'object',properties:{command:{type:'string'},cwd:{type:'string'},timeout_ms:{type:'integer',minimum:1000,maximum:30000}},required:['command'],additionalProperties:false}}
];
const response=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const failure=(id,message)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message}})+'\n');
async function execute(name,args){
 if(name==='system_usage'){
  const [a,b,c]=os.loadavg(),total=os.totalmem(),free=os.freemem();
  return {hostname:os.hostname(),platform:os.platform(),architecture:os.arch(),uptime_seconds:Math.floor(os.uptime()),load_average_1m:a,load_average_5m:b,load_average_15m:c,cpu_logical_count:os.cpus().length,memory_total_bytes:total,memory_free_bytes:free};
 }
 if(name==='system_processes'){
  const sort=args.sort==='memory'?'rss':'%cpu',limit=Math.min(50,Math.max(1,Number(args.limit)||15));
  const {stdout}=await run('/bin/ps',['-axo','pid,ppid,%cpu,rss,comm'],{timeout:7000,maxBuffer:1024*1024});
  const lines=stdout.trim().split('\n').slice(1).map(line=>{
   const m=line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
   return m?{pid:Number(m[1]),ppid:Number(m[2]),cpu_percent:Number(m[3]),rss_kb:Number(m[4]),command:m[5]}:null;
  }).filter(Boolean);
  lines.sort((a,b)=>sort==='rss'?b.rss_kb-a.rss_kb:b.cpu_percent-a.cpu_percent);
  return {sort,processes:lines.slice(0,limit)};
 }
 if(name==='shell_execute'){
  if(typeof args.command!=='string'||!args.command.trim()||args.command.length>8192)throw Error('invalid_command');
  const cwd=typeof args.cwd==='string'?args.cwd:os.homedir();
  if(!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory())throw Error('invalid_cwd');
  const timeout=Math.max(1000,Math.min(30000,Number(args.timeout_ms)||15000));
  try{
   const {stdout,stderr}=await run('/bin/zsh',['-f','-c',args.command],{cwd,timeout,maxBuffer:256*1024,env:{...process.env,HISTFILE:'/dev/null'}});
   return {exit_code:0,stdout,stderr};
  }catch(e){return {exit_code:typeof e.code==='number'?e.code:null,stdout:String(e.stdout||''),stderr:String(e.stderr||e.message).slice(0,65536),timeout:e.killed===true}};
 }
 throw Error('unknown_tool');
}
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 let req;try{req=JSON.parse(line)}catch{continue}
 if(!Object.hasOwn(req,'id'))continue;
 try{
  if(req.method==='initialize')response(req.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'homemcp-macos-tools',version:'1.0.0'}});
  else if(req.method==='tools/list')response(req.id,{tools:spec});
  else if(req.method==='tools/call'){
   const args=req.params?.arguments||{},name=req.params?.name;
   const value=await execute(name,args);
   response(req.id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  }else failure(req.id,'method_not_found');
 }catch(e){failure(req.id,String(e.message||e))}
}
