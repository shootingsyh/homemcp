// Writes secrets only to Manager private stdout pipe; never persist or log plaintext.
import {loadSecret} from '../src/tunnel-store.mjs';
const credential=loadSecret('credential');
const bootstrap=loadSecret('frp-bootstrap')?.token;
if(!credential||!bootstrap){process.exitCode=2;}
else {
 const config=credential.frpc_config.replaceAll('BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP',bootstrap).replaceAll('{{ .Envs.HOMEMCP_FRP_BOOTSTRAP }}',bootstrap).replaceAll('{{ .Envs.HOMEMCP_FRP_TENANT }}',credential.token);
 if(!config.includes(credential.token)||!config.includes(bootstrap))process.exitCode=3;
 else process.stdout.write(config);
}
