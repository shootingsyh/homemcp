#!/usr/bin/env node
// Only generate launchd config after local managed identity and TLS have been provisioned.
// Do not embed tunnel credentials, TLS private keys or OAuth tokens in plists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSecret,dataPath} from '../../src/tunnel-store.mjs';
import {managedPlist,managedPaths} from './managed-launchagents.mjs';
try{
 if(process.platform!=='darwin')throw Error('macos_required');
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 const base=process.env.HOMEMCP_HOME||path.join(os.homedir(),'Library','Application Support','HomeMCP');
 const node=process.execPath,helper=path.join(root,'native','macos','home-mcp-keychain');
 const frpc=process.env.HOMEMCP_FRPC_BIN||path.join(root,'runtime','frpc');
 const c=JSON.parse(fs.readFileSync(path.join(base,'config.json'),'utf8'));
 const credential=loadSecret('credential');
 if(!credential?.subdomain||!loadSecret('frp-bootstrap')?.token)throw Error('managed_credentials_not_ready');
 const expected='https://'+credential.subdomain;
 if(c.publicUrl!==expected||c.connectionMode!=='managed')throw Error('managed_origin_not_bound');
 if(!loadSecret('tls-key-production')?.key||!fs.existsSync(path.join(dataPath(),'cert-production','fullchain.pem')))throw Error('managed_tls_not_ready');
 for(const binary of [node,helper,frpc])if(!fs.existsSync(binary))throw Error('managed_binary_missing');
 const log=path.join(os.homedir(),'Library','Logs','HomeMCP');fs.mkdirSync(log,{recursive:true,mode:0o700});
 const paths=managedPaths();
 fs.mkdirSync(path.dirname(paths.gateway),{recursive:true,mode:0o700});
 for(const mode of ['gateway','frpc']){
  const label='si.homemcp.'+mode;
  fs.writeFileSync(paths[mode],managedPlist({label,node,mode,base,log,helper,frpc}),{mode:0o600});
 }
 console.log('MANAGED_LAUNCHAGENTS_READY');
}catch(e){console.error('Managed service setup:',e.message);process.exitCode=1}
