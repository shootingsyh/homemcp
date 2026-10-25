import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export const managerLabel='si.homemcp.manager';
export function managerPlist(appPath='/Applications/HomeMCP Manager.app'){
 if(!path.posix.isAbsolute(appPath)||!appPath.endsWith('.app')||/[\x00-\x1f]/.test(appPath))throw Error('invalid_manager_app_path');
 const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
 return ['<?xml version="1.0" encoding="UTF-8"?>','<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">','<plist version="1.0"><dict>',`<key>Label</key><string>${managerLabel}</string>`,'<key>ProgramArguments</key><array>',...['/usr/bin/open','-g','-a',appPath].map(s=>'<string>'+esc(s)+'</string>'),'</array>','<key>RunAtLoad</key><true/>','<key>KeepAlive</key><false/>','<key>LimitLoadToSessionType</key><string>Aqua</string>','</dict></plist>'].join('\n')+'\n';
}
export function installManagerLogin({home=os.homedir(),uid=process.getuid(),appPath='/Applications/HomeMCP Manager.app',run=spawnSync}={}){
 if(!Number.isInteger(uid)||uid<=0)throw Error('manager_requires_logged_in_user');
 const plist=managerPlist(appPath);
 const directory=path.join(home,'Library','LaunchAgents');fs.mkdirSync(directory,{recursive:true});
 const target=path.join(directory,managerLabel+'.plist');const temporary=target+'.tmp';
 fs.writeFileSync(temporary,plist,{mode:0o600});fs.renameSync(temporary,target);
 const domain='gui/'+uid;
 const launch=(args,required=true)=>{
  const result=run('/bin/launchctl',args,{encoding:'utf8'});
  if(required&&(result.error||result.status!==0))throw Error('manager_login_registration_failed: '+args[0]);
 };
 launch(['bootout',domain,target],false);
 launch(['enable',domain+'/'+managerLabel]);
 launch(['bootstrap',domain,target]);
 return {label:managerLabel,plist:target,enabled:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 if(process.platform!=='darwin')throw Error('macos_only');
 console.log(JSON.stringify(installManagerLogin()));
}
