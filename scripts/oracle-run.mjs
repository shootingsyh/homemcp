import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {loadSecret,dataPath} from '../src/tunnel-store.mjs';import {startTunnelHTTPS} from '../src/tunnel-https.mjs';
const credential=loadSecret('credential');if(!credential)throw Error('claim_first');
const bootstrap=loadSecret('frp-bootstrap')?.token;
const command=process.argv[2]||'gateway';const certMode=process.argv.includes('--staging')?'staging':'production';
if(command==='gateway'){
 const cert=fs.readFileSync(path.join(dataPath(),'cert-'+certMode,'fullchain.pem'));
 const keyStored=loadSecret('tls-key-'+certMode)?.key;const key=keyStored?.type==='Buffer'?Buffer.from(keyStored.data):keyStored;
 if(!key)throw Error('certificate_required');
 const configBase=process.env.HOMEMCP_HOME||(process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support','HomeMCP'):path.join(process.env.LOCALAPPDATA,'HomeMCP'));const config=JSON.parse(fs.readFileSync(path.join(configBase,'config.json'),'utf8').replace(/^\uFEFF/,''));
 const server=startTunnelHTTPS({cert,key,targetPort:config.port,port:8443,activeOrigin:config.publicUrl});
 server.on('listening',()=>console.log('HOME_TUNNEL_TLS_GATEWAY_STARTED 127.0.0.1:8443'));
} else if(command==='frpc'){
 if(!bootstrap)throw Error('frp_bootstrap_not_provisioned');
 const app=path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,'')),'..');const name=process.platform==='win32'?'frpc.exe':'frpc';const packaged=path.join(app,'runtime',name);const binary=process.env.HOMEMCP_FRPC_BIN||(fs.existsSync(packaged)?packaged:path.join(app,'vendor','frp',name));if(!fs.existsSync(binary))throw Error('frpc_binary_missing');
 const configText=credential.frpc_config.replaceAll('BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP','{{ .Envs.HOMEMCP_FRP_BOOTSTRAP }}').replaceAll(credential.token,'{{ .Envs.HOMEMCP_FRP_TENANT }}');
 if(configText.includes('BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP'))throw Error('bootstrap_replace_failed');
 const cfgPath=path.join(os.tmpdir(),'homemcp-frpc-'+process.pid+'.toml');fs.writeFileSync(cfgPath,configText,{mode:0o600});
 const child=spawn(binary,['-c',cfgPath],{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,HOMEMCP_FRP_BOOTSTRAP:bootstrap,HOMEMCP_FRP_TENANT:credential.token}});
 const cleanup=()=>{try{fs.unlinkSync(cfgPath)}catch{}};
 child.on('error',()=>{cleanup();console.error('FRPC_START_FAILED')});
 child.stdout.on('data',d=>{const line=String(d).replace(/\S{30,}/g,'[redacted]');process.stdout.write(line)});
 child.stderr.on('data',d=>{const line=String(d).replace(/\S{30,}/g,'[redacted]');process.stderr.write(line)});
 child.on('exit',code=>{cleanup();console.log('FRPC_EXIT',code)});
 process.on('SIGINT',()=>{child.kill();cleanup()});process.on('SIGTERM',()=>{child.kill();cleanup()});
} else throw Error('unknown_run_mode');
