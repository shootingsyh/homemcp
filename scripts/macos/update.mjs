// Standalone updater: copy the runner and runtime before replacing the installed app.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
const exec = promisify(execFile);
const APP='/Applications/HomeMCP Manager.app';
export const base=path.join(os.homedir(),'Library/Application Support/HomeMCP/updates');
const MAX_BYTES=512*1024*1024;
export function validateSource(source) {
  if(Boolean(source.pkg)===Boolean(source.url)) throw Error('Choose one local package or remote URL.');
  if(source.sha256 && !/^[a-f0-9]{64}$/i.test(source.sha256)) throw Error('Invalid SHA-256.');
  if(source.url) {
    const u=new URL(source.url);
    if(u.protocol!=='https:' || u.username || u.password) throw Error('Use HTTPS without embedded credentials.');
    if(!source.sha256) throw Error('Remote builds require a trusted SHA-256.');
  } else if(!path.isAbsolute(source.pkg) || path.extname(source.pkg)!=='.pkg') throw Error('Choose an absolute .pkg path.');
  return source;
}
export async function digest(file) {
  const hash=crypto.createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
export async function discover(roots=[path.join(os.homedir(),'homemcp/build/macos-dist'),path.join(os.homedir(),'Downloads')]) {
  const found=[];
  for(const root of roots) {
    for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(()=>[])) {
      if(!entry.isFile() || !entry.name.endsWith('.pkg') || !entry.name.startsWith('HomeMCP'))continue;
      const pkg=path.join(root,entry.name),st=await fs.stat(pkg);
      found.push({pkg,modified:st.mtimeMs,size:st.size});
    }
  }
  return found.sort((a,b)=>b.modified-a.modified);
}
export async function download(url,destination,{fetcher=fetch,maxBytes=MAX_BYTES}={}) {
  // Validate every redirect rather than letting fetch downgrade to HTTP.
  for(let count=0;count<=5;count++) {
    const u=new URL(url);
    if(u.protocol!=='https:'||u.username||u.password)throw Error('Unsafe download redirect.');
    const res=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(120000)});
    if([301,302,303,307,308].includes(res.status)) {
      await res.body?.cancel();
      if(!res.headers.get('location'))throw Error('Redirect has no location.');
      url=new URL(res.headers.get('location'),url).href;continue;
    }
    if(!res.ok)throw Error('Download failed: HTTP '+res.status);
    if(Number(res.headers.get('content-length'))>maxBytes)throw Error('Package too large.');
    const handle=await fs.open(destination,'wx',0o600);
    try {
      let bytes=0;
      for await(const chunk of res.body) {
        bytes+=chunk.length;if(bytes>maxBytes)throw Error('Package too large.');
        await handle.writeFile(chunk);
      }
    } finally {await handle.close();}
    return;
  }
  throw Error('Too many redirects.');
}
export function shellQuote(value){return "'"+value.replaceAll("'","'\\''")+"'";}
export async function runUpdate(job,source,{command=exec,platform=process.platform,fetcher=fetch,health=checkHealth,appPath=APP}={}) {
  const status=async(phase,detail,extra={})=>{
    const value={phase,detail,updatedAt:new Date().toISOString(),...extra};
    await fs.writeFile(path.join(job,'status.tmp'),JSON.stringify(value),{mode:0o600});
    await fs.rename(path.join(job,'status.tmp'),path.join(job,'status.json'));
  };
  try {
    validateSource(source);
    if(platform!=='darwin')throw Error('Installation requires macOS.');
    const pkg=path.join(job,'update.pkg');
    await status('preparing','Staging selected build.');
    if(source.url)await download(source.url,pkg,{fetcher});
    else {
      const st=await fs.stat(source.pkg);
      if(!st.isFile()||st.size>MAX_BYTES)throw Error('Invalid package file.');
      await fs.copyFile(source.pkg,pkg);
    }
    const sha256=await digest(pkg);
    if(source.sha256 && source.sha256.toLowerCase()!==sha256)throw Error('SHA-256 mismatch; installation cancelled.');
    await status('verifying','Checking package payload and application signature.',{sha256});
    const expanded=path.join(job,'expanded');
    await command('/usr/sbin/pkgutil',['--expand-full',pkg,expanded],{timeout:120000});
    const matches=[];
    async function locate(dir,depth=0) {
      if(depth>8)return;
      for(const e of await fs.readdir(dir,{withFileTypes:true})) {
        if(!e.isDirectory())continue;
        const p=path.join(dir,e.name);
        if(e.name==='HomeMCP Manager.app')matches.push(p);
        else await locate(p,depth+1);
      }
    }
    await locate(expanded);
    if(matches.length!==1)throw Error('Package must contain exactly one HomeMCP Manager.app.');
    const candidate=matches[0];
    const plist=path.join(candidate,'Contents/Info.plist');
    const {stdout:id}=await command('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw',plist]);
    if(id.trim()!=='si.homemcp.manager')throw Error('Wrong application identifier.');
    await command('/usr/bin/codesign',['--verify','--deep','--strict',candidate],{timeout:120000});
    // A signature validates the bundle; the selected local package / trusted remote
    // checksum authorizes the entire installer, including its package scripts.
    const {stdout:version}=await command('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw',plist]);
    await fs.rm(expanded,{recursive:true,force:true});
    await status('authorizing','Enter the administrator password in the macOS authorization dialog.',{sha256,version:version.trim()});
    const shell='/usr/sbin/installer -pkg '+shellQuote(pkg)+' -target /';
    const apple='do shell script '+JSON.stringify(shell)+' with administrator privileges';
    const result=await command('/usr/bin/osascript',['-e',apple],{timeout:15*60*1000,maxBuffer:1024*1024});
    await fs.writeFile(path.join(job,'installer.log'),result.stdout+'\n'+result.stderr,{mode:0o600});
    await status('checking','Installer finished. Checking installed application and local Host.');
    await command('/usr/bin/codesign',['--verify','--deep','--strict',appPath],{timeout:120000});
    const {stdout:installed}=await command('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw',appPath+'/Contents/Info.plist']);
    if(installed.trim()!==version.trim())throw Error('Installed version does not match selected build.');
    const installedDigest=await digest(appPath+'/Contents/MacOS/HomeMCP.Manager');
    // Stop only Manager, not the Host/tunnel or this standalone updater.
    await command('/usr/bin/pkill',['-x','HomeMCP.Manager']).catch(()=>{});
    await command('/usr/bin/open',[appPath]);
    const healthy=await health();
    await status(healthy?'complete':'needs_attention',healthy?'Update installed; Manager reopened and local Host is reachable.':'Update installed; local Host did not become reachable. See installer.log.',{sha256,version:installed.trim(),installedDigest});
    return healthy;
  } catch(e) {
    await status('failed',e.message);
    throw e;
  }
}
async function checkHealth() {
  for(let attempt=0;attempt<30;attempt++) {
    try {
      const config=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/HomeMCP/config.json'),'utf8'));
      if(!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error('No local port');
      await new Promise((resolve,reject)=>{
        const s=net.createConnection({host:'127.0.0.1',port:config.port});
        s.setTimeout(1000,()=>s.destroy(Error('Host timeout')));
        s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);
      });return true;
    }catch{}
    await new Promise(r=>setTimeout(r,1000));
  }
  return false;
}
async function launch(source) {
  validateSource(source);
  if(process.platform!=='darwin')throw Error('Installation requires macOS.');
  await fs.mkdir(base,{recursive:true,mode:0o700});
  const job=await fs.mkdtemp(path.join(base,'job-'));
  // Reserve before spawning, so two UI clicks cannot create competing installers.
  const lock=path.join(base,'active.lock');
  try {await fs.mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('Another update is active. Check update status before retrying.');throw e;}
  try {
    await fs.copyFile(process.execPath,path.join(job,'node'));await fs.chmod(path.join(job,'node'),0o700);
    await fs.copyFile(fileURLToPath(import.meta.url),path.join(job,'update.mjs'));
    await fs.writeFile(path.join(job,'source.json'),JSON.stringify(source),{mode:0o600});
    await fs.writeFile(path.join(job,'status.json'),JSON.stringify({phase:'starting',detail:'Starting independent updater.'}),{mode:0o600});
    await fs.writeFile(path.join(base,'latest.json'),JSON.stringify({job}),{mode:0o600});
    const child=spawn(path.join(job,'node'),[path.join(job,'update.mjs'),'worker',job],{detached:true,stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    return {job,pid:child.pid};
  }catch(e){await fs.rmdir(lock).catch(()=>{});throw e;}
}
async function main() {
  const [mode,...args]=process.argv.slice(2);
  if(mode==='discover')return console.log(JSON.stringify(await discover()));
  if(mode==='launch')return console.log(JSON.stringify(await launch(JSON.parse(args[0]))));
  if(mode==='worker') {
    const job=args[0];
    try{await runUpdate(job,JSON.parse(await fs.readFile(path.join(job,'source.json'),'utf8')));}
    finally{await fs.rmdir(path.join(base,'active.lock')).catch(()=>{});}
    return;
  }
  throw Error('Usage: update.mjs discover | launch <source-json>');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
