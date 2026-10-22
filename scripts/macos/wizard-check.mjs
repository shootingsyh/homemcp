#!/usr/bin/env node
// Read-only wizard completion probe. Never reports success without a bound origin
// and a registered Passkey on the current local Host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base=process.env.HOMEMCP_HOME||path.join(os.homedir(),'Library','Application Support','HomeMCP');
try {
 const c=JSON.parse(fs.readFileSync(path.join(base,'config.json'),'utf8'));
 const r=await fetch('http://127.0.0.1:'+c.port+'/admin/setup-status',{headers:{Authorization:'Bearer '+c.security.adminToken},signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('setup_status_http_'+r.status);
 const state=await r.json();
 const origin=state.publicOrigin||'';
 const verified=origin.startsWith('https://')&&state.hostReady===true;
 const complete=verified&&state.passkeyCount>0;
 console.log(JSON.stringify({origin,passkeyCount:state.passkeyCount||0,complete,connectionMode:c.connectionMode||'local'}));
}catch(e){console.error('setup check:',e.message);process.exitCode=1}
