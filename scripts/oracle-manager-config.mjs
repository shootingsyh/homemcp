// Public official frps handshake constant is embedded; user access is gated by
// the per-user token enforced by the frps authorization plugin.
import {loadSecret} from '../src/tunnel-store.mjs';
import {renderFrpcConfig} from '../src/frp-bootstrap.mjs';
const credential=loadSecret('credential');
if(!credential){process.exitCode=2;}
else {
 try {
  // Custom frps deployments can set their own global auth.token in settings.
  const bootstrapOverride=process.env.HOMEMCP_FRP_BOOTSTRAP_OVERRIDE;
  process.stdout.write(renderFrpcConfig(credential,{override:bootstrapOverride}));
 } catch(e){console.error('FRPC_CONFIG_ERROR',e.message);process.exitCode=3;}
}
