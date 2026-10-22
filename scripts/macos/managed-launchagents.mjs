import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const escapeXml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const entry=(key,value)=>'<key>'+escapeXml(key)+'</key><string>'+escapeXml(value)+'</string>';
export function managedPlist({label,node,mode,base,log,helper,frpc}){
 if(!['gateway','frpc'].includes(mode))throw Error('unknown_managed_mode');
 const args=[node,path.join(root,'scripts','oracle-run.mjs'),mode];
 const env={HOMEMCP_HOME:base,HOMEMCP_MACOS_KEYCHAIN_HELPER:helper,...(frpc?{HOMEMCP_FRPC_BIN:frpc}:{})};
 return [
 '<?xml version="1.0" encoding="UTF-8"?>',
 '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
 '<plist version="1.0"><dict>',
 entry('Label',label),
 '<key>ProgramArguments</key><array>',...args.map(v=>'<string>'+escapeXml(v)+'</string>'),'</array>',
 entry('WorkingDirectory',root),
 '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>',
 entry('StandardOutPath',path.join(log,mode+'.stdout.log')),
 entry('StandardErrorPath',path.join(log,mode+'.stderr.log')),
 '<key>EnvironmentVariables</key><dict>',
 ...Object.entries(env).map(([k,v])=>entry(k,v)),
 '</dict></dict></plist>'
 ].join('\n')+'\n';
}
export function managedPaths(home=os.homedir()){
 const agents=path.join(home,'Library','LaunchAgents');
 return {
  gateway:path.join(agents,'si.homemcp.gateway.plist'),
  frpc:path.join(agents,'si.homemcp.frpc.plist')
 };
}
