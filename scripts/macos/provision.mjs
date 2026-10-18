import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const home=process.env.HOME||os.homedir();
const base=process.env.HOMEMCP_HOME||path.join(home,'Library','Application Support','HomeMCP');
const configPath=path.join(base,'config.json');
function freePort(){
 return new Promise((resolve,reject)=>{
  const server=net.createServer();
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{
   const port=server.address().port;
   server.close(e=>e?reject(e):resolve(port));
  });
 });
}
fs.mkdirSync(base,{recursive:true,mode:0o700});
fs.chmodSync(base,0o700);
if(fs.existsSync(configPath)){
 console.log('HomeMCP config already exists; not overwriting');
 process.exit(0);
}
const ports=new Set();
async function uniquePort(){
 for(let i=0;i<15;i++){
  const p=await freePort();
  if(!ports.has(p)){ports.add(p);return p;}
 }
 throw new Error('unable_to_allocate_port');
}
const hostPort=await uniquePort(),browserPort=await uniquePort();
const browserRoot=path.join(base,'BrowserProfile');
const node=process.execPath;
const browserCli=path.join(project,'build','macos-worker','node_modules','@playwright','mcp','cli.js');
if(!fs.existsSync(browserCli))throw new Error('Playwright MCP worker installation required before provisioning');
const config={
 installationId:crypto.randomUUID().replaceAll('-',''),
 host:'127.0.0.1',port:hostPort,dataDir:path.join(base,'data'),
 token:crypto.randomBytes(32).toString('hex'),
 security:{
  adminToken:crypto.randomBytes(32).toString('hex'),
  approvalTimeoutMs:600000,
  credentialVaultEnabled:true,
  policy:{browser_navigate:'allow',browser_snapshot:'allow'}
 },
 egress:{enabled:false,mode:'disabled'},
 workers:[{
  name:'browser',command:node,
  args:[browserCli,'--browser','chrome','--user-data-dir',browserRoot,'--shared-browser-context','--host','127.0.0.1','--port',String(browserPort)],
  url:'http://127.0.0.1:'+browserPort+'/mcp',startupMs:35000
 }],
 tools:{
  browser_navigate:{worker:'browser',upstream:'browser_navigate',description:'Navigate browser',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url']}},
  browser_snapshot:{worker:'browser',upstream:'browser_snapshot',description:'Read browser page',inputSchema:{type:'object',properties:{}}}
 }
};
const temp=configPath+'.tmp-'+process.pid;
try{
 fs.writeFileSync(temp,JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
 fs.renameSync(temp,configPath);
 fs.chmodSync(configPath,0o600);
}catch(e){try{fs.unlinkSync(temp)}catch{}throw e}
console.log('Created local-only macOS configuration at '+configPath);
