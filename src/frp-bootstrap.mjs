import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Public handshake constant for the official frps service. Not an access credential.
// Per-user FRP authorization remains enforced by the server-side plugin.
export const OFFICIAL_FRP_BOOTSTRAP_TOKEN='5c97e6ab60c9673ac984f127479b090b922b9c5337e2ecda306d10c44b838f6d';

export function isOfficialFrp(credential){
 return typeof credential?.subdomain==='string' && /^[a-z0-9-]+\.tunnel\.homemcp\.si$/.test(credential.subdomain);
}
// A self-hosted deployment explicitly supplies its own frps auth.token.
// The official constant is never used for a non-official domain.
export function frpBootstrapToken(credential,{override}={}){
 if(typeof override==='string'&&override.trim())return override.trim();
 if(isOfficialFrp(credential))return OFFICIAL_FRP_BOOTSTRAP_TOKEN;
 throw Error('self_hosted_frp_token_required');
}
export function renderFrpcConfig(credential,options={}){
 if(typeof credential?.frpc_config!=='string'||typeof credential?.token!=='string')throw Error('claim_first');
 const bootstrap=frpBootstrapToken(credential,options);
 const config=credential.frpc_config
  .replaceAll('BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP',bootstrap)
  .replaceAll('{{ .Envs.HOMEMCP_FRP_BOOTSTRAP }}',bootstrap)
  .replaceAll('{{ .Envs.HOMEMCP_FRP_TENANT }}',credential.token);
 if(config.includes('BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP')||!config.includes(credential.token))throw Error('frpc_config_render_failed');
 return config;
}

export function configuredFrpOverride(){
 const base=process.env.HOMEMCP_HOME||
  (process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support','HomeMCP'):
   path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'HomeMCP'));
 let setting;
 try {
  const config=JSON.parse(fs.readFileSync(path.join(base,'config.json'),'utf8').replace(/^\uFEFF/,''));
  setting=config.frp?.bootstrapToken;
 }catch{}
 return process.env.HOMEMCP_FRP_BOOTSTRAP_OVERRIDE||setting;
}
