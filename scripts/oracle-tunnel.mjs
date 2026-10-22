import acme from 'acme-client';import crypto from 'node:crypto';import fs from 'node:fs';import path from 'node:path';
import {TunnelClient,validateClaim} from '../src/tunnel-client.mjs';import {saveSecret,loadSecret,savePublic,loadPublic,dataPath} from '../src/tunnel-store.mjs';
const command=process.argv[2];const mode=process.argv.includes('--production')?'production':'staging';
const state=loadSecret('enrollment')||loadPublic('enrollment')||{};
const existing=loadSecret('credential');const client=new TunnelClient({token:existing?.token});
async function main(){
 switch(command){
 case 'bootstrap':{
  const chunks=[];for await(const ch of process.stdin)chunks.push(ch);const token=Buffer.concat(chunks).toString('utf8').trim();if(token.length<20)throw Error('invalid_bootstrap_length');saveSecret('frp-bootstrap',{token});console.log('FRP_BOOTSTRAP_STORED');break;
 }
 case 'enroll':{
  if(state.id)throw Error('existing_enrollment_use_claim_or_reset');
  const username=process.argv[3]||'clientdev';const plan=process.argv[4]||'monthly';
  const r=await client.enroll(username,plan);saveSecret('enrollment',{id:r.enrollment_id,username,plan,subdomain:r.subdomain});console.log('ENROLL_STATUS',r.status,'USERNAME',username);break;
 }
 case 'claim':{
  if(!state.id)throw Error('enroll_first');
  const r=await client.getEnrollment(state.id);const c=validateClaim(r);
  if(!c){console.log('CLAIM_STATUS',r.status);break}
  saveSecret('credential',c);console.log('CREDENTIAL_SAVED_PROTECTED',c.subdomain);break;
 }
 case 'account':{
  if(!existing)throw Error('claim_first');const a=await client.account();console.log(JSON.stringify(a));break;
 }
 case 'certificate':{
  if(!existing)throw Error('claim_first');
  const domain=existing.subdomain;const priorAccountKey=loadSecret('acme-account')?.key;const accountKey=priorAccountKey?.type==='Buffer'?Buffer.from(priorAccountKey.data):(priorAccountKey||await acme.crypto.createPrivateKey());saveSecret('acme-account',{key:accountKey});
  const [certKey,csr]=await acme.crypto.createCsr({commonName:domain,altNames:[domain]});
  const directory=mode==='staging'?acme.directory.letsencrypt.staging:acme.directory.letsencrypt.production;
  const ca=new acme.Client({directoryUrl:directory,accountKey});
  const ids=new Map();
  const cert=await ca.auto({csr,termsOfServiceAgreed:true,challengePriority:['dns-01'],skipChallengeVerification:true,
    challengeCreateFn:async(authz,challenge,keyAuthorization)=>{
      const digest=keyAuthorization; // acme-client supplies the final DNS-01 digest
      const r=await client.createChallenge(digest);ids.set(challenge.token,r.id);await client.waitPropagation(r.id,{intervalMs:10000,attempts:50});
    },
    challengeRemoveFn:async(authz,challenge)=>{const id=ids.get(challenge.token);if(id){await client.removeChallenge(id);ids.delete(challenge.token)}}
  });
  const dir=path.join(dataPath(),'cert-'+mode);fs.mkdirSync(dir,{recursive:true});
  saveSecret('tls-key-'+mode,{key:certKey});fs.writeFileSync(path.join(dir,'fullchain.pem'),cert,{mode:0o600});
  savePublic('tls-'+mode,{domain,issuedAt:new Date().toISOString(),mode});console.log('CERTIFICATE_ISSUED',mode,domain);
  break;
 }
 case 'delete-mock':{
  if(!existing)throw Error('claim_first');await client.deleteMockAccount();console.log('MOCK_ACCOUNT_DELETED');break;
 }
 default:console.log('usage: oracle-tunnel.mjs enroll [username] [monthly|annual] | claim | account | certificate [--production] | delete-mock');
 }
}
main().catch(e=>{console.error('TUNNEL_ERROR',e.code||e.message);process.exitCode=1});
