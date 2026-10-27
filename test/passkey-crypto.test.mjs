import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {PasskeyManager} from '../src/passkeys.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-es256-'));const origin='https://crypto-test.example',rpID='crypto-test.example';
 const manager=new PasskeyManager(dir,{origin,rpID});t.after(()=>{manager.close();fs.rmSync(dir,{recursive:true,force:true})});
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=publicKey.export({format:'jwk'});
 const cose=Buffer.concat([Buffer.from([0xa5,1,2,3,0x26,0x20,1,0x21,0x58,0x20]),Buffer.from(jwk.x,'base64url'),Buffer.from([0x22,0x58,0x20]),Buffer.from(jwk.y,'base64url')]);
 const id=crypto.randomBytes(24).toString('base64url');manager.db.prepare('INSERT INTO passkeys(id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?)').run(id,cose.toString('base64url'),0,'["internal"]',Date.now());
 async function response({wrongOrigin=false,tampered=false}={}){
  const options=await manager.authenticationOptions();
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.options.challenge,origin:wrongOrigin?'https://wrong.example':origin,crossOrigin:false}));
  const count=Buffer.alloc(4);count.writeUInt32BE(1);
  const auth=Buffer.concat([crypto.createHash('sha256').update(rpID).digest(),Buffer.from([5]),count]);
  const signature=crypto.sign('sha256',Buffer.concat([auth,crypto.createHash('sha256').update(client).digest()]),privateKey);if(tampered)signature[signature.length-1]^=1;
  return {challengeId:options.challengeId,value:{id,rawId:id,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:auth.toString('base64url'),signature:signature.toString('base64url')},clientExtensionResults:{},authenticatorAttachment:'platform'}};
 }
 return {manager,response};
}
test('real ES256 Passkey authentication verifies ASN.1 signature and creates a session',async t=>{
 const {manager,response}=fixture(t),r=await response();const session=await manager.verifyAuthentication(r.challengeId,r.value);assert.equal(typeof session,'string');assert.equal(manager.isSession(session),true);assert.equal(await manager.verifyAuthentication(r.challengeId,r.value),null);
});
test('tampered ES256 assertion cannot create a login session',async t=>{
 const {manager,response}=fixture(t),r=await response({tampered:true});const session=await manager.verifyAuthentication(r.challengeId,r.value).catch(()=>null);assert.equal(session,null);
});
test('ES256 assertion for another origin cannot create a login session',async t=>{
 const {manager,response}=fixture(t),r=await response({wrongOrigin:true});const session=await manager.verifyAuthentication(r.challengeId,r.value).catch(()=>null);assert.equal(session,null);
});
