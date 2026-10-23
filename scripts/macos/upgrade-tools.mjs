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
const temp=file+'.migration-'+process.pid;
try{
 fs.writeFileSync(temp,JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
 fs.renameSync(temp,file);
 fs.chmodSync(file,0o600);
}catch(e){try{fs.unlinkSync(temp)}catch{}throw e}
console.log('macOS tool mappings installed; existing policies preserved');
