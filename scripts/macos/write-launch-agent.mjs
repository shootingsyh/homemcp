import fs from 'node:fs';
import path from 'node:path';
const {HOMEMCP_APP_ROOT:root,HOMEMCP_NODE_PATH:node,HOMEMCP_PLIST_PATH:plist,HOMEMCP_BASE_PATH:base,HOME:home}=process.env;
if(!root||!node||!plist||!base||!home)throw new Error('missing launch agent paths');
const esc=x=>x.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const log=path.join(home,'Library','Logs','HomeMCP');
const lines=[
'<?xml version="1.0" encoding="UTF-8"?>',
'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
'<plist version="1.0"><dict>',
'<key>Label</key><string>xyz.shootingsyh.homemcp</string>',
'<key>ProgramArguments</key><array>',
...([node,path.join(root,'src','server.mjs'),'--config',path.join(base,'config.json')].map(x=>'<string>'+esc(x)+'</string>')),
'</array>',
'<key>WorkingDirectory</key><string>'+esc(root)+'</string>',
'<key>RunAtLoad</key><true/>',
'<key>KeepAlive</key><true/>',
'<key>StandardOutPath</key><string>'+esc(path.join(log,'stdout.log'))+'</string>',
'<key>StandardErrorPath</key><string>'+esc(path.join(log,'stderr.log'))+'</string>',
'<key>EnvironmentVariables</key><dict>',
'<key>HOMEMCP_MACOS_KEYCHAIN_HELPER</key><string>'+esc(path.join(root,'native','macos','home-mcp-keychain'))+'</string>',
'</dict></dict></plist>'
];
fs.writeFileSync(plist,lines.join('\n')+'\n',{mode:0o600});
