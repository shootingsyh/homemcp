#!/usr/bin/env node
// Add new macOS tool mappings to existing installations without replacing their
// identity, OAuth settings, approved passkeys, per-tool policy or worker settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin'&&process.env.HOMEMCP_TEST_MAC_TOOLS!=='1')process.exit(0);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=process.env.HOMEMCP_HOME||path.join(os.homedir(),'Library','Application Support','HomeMCP');
const file=path.join(base,'config.json');
if(!fs.existsSync(file))process.exit(0);
const config=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const node=process.execPath;
config.workers??=[];
config.tools??={};
config.security??={};
config.security.policy??={};
const ensure=(name,tool,policy='allow')=>{
 if(!Object.hasOwn(config.tools,name))config.tools[name]=tool;
 if(!Object.hasOwn(config.security.policy,name))config.security.policy[name]=policy;
};
if(!config.workers.some(x=>x.name==='mac-system'))config.workers.push({
 name:'mac-system',transport:'stdio',command:node,args:[path.join(root,'scripts','macos','diagnostics-worker.mjs')]
});
ensure('system_usage',{worker:'mac-system',upstream:'system_usage',description:'Mac load, memory and uptime',inputSchema:{type:'object',properties:{}}});
ensure('system_processes',{worker:'mac-system',upstream:'system_processes',description:'List Mac processes',inputSchema:{type:'object',properties:{sort:{type:'string'},limit:{type:'integer'}}}});
ensure('shell_execute',{worker:'mac-system',upstream:'shell_execute',description:'Execute a Mac shell command',inputSchema:{type:'object',properties:{command:{type:'string'},cwd:{type:'string'},timeout_ms:{type:'integer'}},required:['command']}});
if(config.workers.some(x=>x.name==='browser'))ensure('browser_tabs',{worker:'browser',upstream:'browser_tabs',description:'List or switch HomeMCP managed Chrome tabs',inputSchema:{type:'object',properties:{action:{type:'string'},index:{type:'integer'}}}});
const nativeHelper=path.join(root,'..','..','MacOS','HomeMCP.Desktop');
if(fs.existsSync(nativeHelper)){
 if(!config.workers.some(x=>x.name==='mac-desktop'))config.workers.push({
  name:'mac-desktop',transport:'stdio',command:node,
  args:[path.join(root,'scripts','macos','desktop-worker.mjs')],
  env:{HOMEMCP_MAC_DESKTOP_HELPER:nativeHelper}
 });
 const items={
  desktop_permissions:{description:'Check desktop helper Accessibility and Screen Recording permissions',properties:{}},
  desktop_screenshot:{description:'Capture Mac primary display',properties:{}},
  desktop_snapshot:{description:'Read foreground Mac application and window',properties:{}},
  desktop_click:{description:'Click Mac desktop coordinates',properties:{x:{type:'number'},y:{type:'number'}},required:['x','y']},
  desktop_type:{description:'Type into foreground Mac application',properties:{text:{type:'string'}},required:['text']},
  desktop_scroll:{description:'Scroll Mac desktop',properties:{lines:{type:'integer'}},required:['lines']},
  desktop_shortcut:{description:'Send Mac keycode and modifier shortcut',properties:{keycode:{type:'integer'},modifiers:{type:'array',items:{type:'string'}}},required:['keycode']}
 };
 for(const [name,item] of Object.entries(items))ensure(name,{
  worker:'mac-desktop',upstream:name,description:item.description,
  inputSchema:{type:'object',properties:item.properties,...(item.required?{required:item.required}:{}),additionalProperties:false}
 });
}
const temp=file+'.migration-'+process.pid;
try{
 fs.writeFileSync(temp,JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
 fs.renameSync(temp,file);
 fs.chmodSync(file,0o600);
}catch(e){try{fs.unlinkSync(temp)}catch{}throw e}
console.log('macOS tool mappings installed; existing policies preserved');
