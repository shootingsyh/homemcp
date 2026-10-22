#!/usr/bin/env node
// Create the same short-lived Passkey enrollment QR used by Windows Manager.
// Prints a local setup URL, never prints the admin credential or invitation secret in logs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const base=process.env.HOMEMCP_HOME||path.join(os.homedir(),'Library','Application Support','HomeMCP');
try{
 const c=JSON.parse(fs.readFileSync(path.join(base,'config.json'),'utf8'));
 if(!c.security?.adminToken||!c.port)throw Error('local_config_missing');
 if(!c.publicUrl||!c.security?.rpOrigin)throw Error('public_https_origin_required');
 const r=await fetch('http://127.0.0.1:'+c.port+'/admin/enrollment',{
  method:'POST',headers:{Authorization:'Bearer '+c.security.adminToken},signal:AbortSignal.timeout(5000)
 });
 if(!r.ok)throw Error('passkey_invitation_http_'+r.status);
 const info=await r.json(),invite=new URL(info.url);
 if(invite.origin!==c.publicUrl||!invite.searchParams.has('enroll'))throw Error('passkey_invitation_origin_mismatch');
 console.log('http://127.0.0.1:'+c.port+'/setup?enroll='+encodeURIComponent(invite.searchParams.get('enroll')));
}catch(e){console.error('Unable to create Passkey QR:',e.message);process.exitCode=1}
