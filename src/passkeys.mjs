import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const b64=data=>Buffer.from(data).toString('base64url');
const unb64=text=>new Uint8Array(Buffer.from(text,'base64url'));
export class PasskeyManager{
 constructor(dataDir,{rpID='localhost',origin='http://localhost',challengeTTL=120000,sessionTTL=600000}={}){
 fs.mkdirSync(dataDir,{recursive:true});this.db=new DatabaseSync(path.join(dataDir,'passkeys.sqlite'));
 this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);");
 this.db.exec('CREATE TABLE IF NOT EXISTS enrollment_invites (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at INTEGER)');
  this.rpID=rpID;this.origin=origin;this.challengeTTL=challengeTTL;this.sessionTTL=sessionTTL;
 }
 async sdk(){return import('@simplewebauthn/server')}
 issueEnrollmentInvite(){
  const token=crypto.randomBytes(32).toString('base64url');
  const digest=this.digest(token),expiresAt=Date.now()+10*60*1000;
  this.db.prepare('DELETE FROM enrollment_invites WHERE expires_at<? OR consumed_at IS NOT NULL').run(Date.now());
  this.db.prepare('INSERT INTO enrollment_invites(digest,expires_at) VALUES(?,?)').run(digest,expiresAt);
  return {token,expires_at:expiresAt};
 }
 validInvite(token){
  if(typeof token!=='string'||token.length>128||token.length<32)return false;
  const r=this.db.prepare('SELECT expires_at,consumed_at FROM enrollment_invites WHERE digest=?').get(this.digest(token));
  return !!r&&!r.consumed_at&&r.expires_at>Date.now();
 }

 storeChallenge(kind,challenge){const id=crypto.randomUUID();this.db.prepare('INSERT INTO challenges VALUES(?,?,?,?)').run(id,kind,challenge,Date.now()+this.challengeTTL);return id}
 consumeChallenge(id,kind){if(typeof id!=='string'||!/^[a-f\d-]{36}$/.test(id))return null;const row=this.db.prepare('SELECT * FROM challenges WHERE id=?').get(id);this.db.prepare('DELETE FROM challenges WHERE id=?').run(id);if(!row||row.kind!==kind||row.expires_at<=Date.now())return null;return row.challenge}
 registered(){return this.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n>0}
 async registrationOptions(invite=null){if(invite!==null&&!this.validInvite(invite))throw new Error('invalid_enrollment_invite');const {generateRegistrationOptions}=await this.sdk();const options=await generateRegistrationOptions({rpName:'HomeMCP',rpID:this.rpID,userName:'HomeMCP owner',userID:crypto.randomBytes(32),attestationType:'none',authenticatorSelection:{userVerification:'required',residentKey:'preferred'},excludeCredentials:this.db.prepare('SELECT id FROM passkeys').all().map(x=>({id:x.id}))});return {challengeId:this.storeChallenge(invite===null?'register':'register:'+this.digest(invite),options.challenge),options}}
 async verifyRegistration(challengeId,response,invite=null){if(invite!==null&&!this.validInvite(invite))return false;const expectedChallenge=this.consumeChallenge(challengeId,invite===null?'register':'register:'+this.digest(invite));if(!expectedChallenge)return false;const {verifyRegistrationResponse}=await this.sdk();const result=await verifyRegistrationResponse({response,expectedChallenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true});if(!result.verified||!result.registrationInfo)return false;const {credential}=result.registrationInfo;if(invite!==null){
   const changed=this.db.prepare('UPDATE enrollment_invites SET consumed_at=? WHERE digest=? AND consumed_at IS NULL AND expires_at>?').run(Date.now(),this.digest(invite),Date.now()).changes;
   if(!changed)return false;
  }
  this.db.prepare('INSERT INTO passkeys(id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?)').run(credential.id,b64(credential.publicKey),credential.counter,JSON.stringify(credential.transports||[]),Date.now());return true}
 list(){return this.db.prepare('SELECT id,created_at FROM passkeys ORDER BY created_at ASC').all().map(x=>({id:x.id,created_at:x.created_at}));}
 async managementOptions(action,id=''){if(!this.registered())throw Error('no_passkeys');const {generateAuthenticationOptions}=await this.sdk();const options=await generateAuthenticationOptions({rpID:this.rpID,userVerification:'required',allowCredentials:this.db.prepare('SELECT id,transports FROM passkeys').all().map(x=>({id:x.id,transports:JSON.parse(x.transports||'[]')}))});return {challengeId:this.storeChallenge('manage:'+action+':'+id,options.challenge),options};}
 async verifyManagement(challengeId,response,action,id=''){const expectedChallenge=this.consumeChallenge(challengeId,'manage:'+action+':'+id);if(!expectedChallenge||!response?.id)return false;const row=this.db.prepare('SELECT * FROM passkeys WHERE id=?').get(response.id);if(!row)return false;const {verifyAuthenticationResponse}=await this.sdk();const result=await verifyAuthenticationResponse({response,expectedChallenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true,credential:{id:row.id,publicKey:unb64(row.public_key),counter:row.counter,transports:JSON.parse(row.transports||'[]')}});if(!result.verified)return false;this.db.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(result.authenticationInfo.newCounter,row.id);return true;}
 remove(id){if(this.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n<=1)throw Error('cannot_remove_last_passkey');const result=this.db.prepare('DELETE FROM passkeys WHERE id=?').run(id);return result.changes===1;}
 async decisionOptions(approvalId,decision){
  if(!['approve','reject'].includes(decision)||!this.registered())throw new Error('invalid_decision');
  const {generateAuthenticationOptions}=await this.sdk();
  const options=await generateAuthenticationOptions({rpID:this.rpID,userVerification:'required',allowCredentials:this.db.prepare('SELECT id,transports FROM passkeys').all().map(x=>({id:x.id,transports:JSON.parse(x.transports||'[]')}))});
  return {challengeId:this.storeChallenge('decision:'+approvalId+':'+decision,options.challenge),options};
 }
 async verifyDecision(challengeId,response,approvalId,decision){
  const kind='decision:'+approvalId+':'+decision;
  const expectedChallenge=this.consumeChallenge(challengeId,kind);
  if(!expectedChallenge||!response||typeof response.id!=='string')return false;
  const row=this.db.prepare('SELECT * FROM passkeys WHERE id=?').get(response.id);if(!row)return false;
  const {verifyAuthenticationResponse}=await this.sdk();
  const result=await verifyAuthenticationResponse({response,expectedChallenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true,credential:{id:row.id,publicKey:unb64(row.public_key),counter:row.counter,transports:JSON.parse(row.transports||'[]')}});
  if(!result.verified)return false;
  this.db.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(result.authenticationInfo.newCounter,row.id);return true;
 }
 async authenticationOptions(){if(!this.registered())throw new Error('no_passkey_registered');const {generateAuthenticationOptions}=await this.sdk();const options=await generateAuthenticationOptions({rpID:this.rpID,userVerification:'required',allowCredentials:this.db.prepare('SELECT id,transports FROM passkeys').all().map(x=>({id:x.id,transports:JSON.parse(x.transports||'[]')}))});return {challengeId:this.storeChallenge('authenticate',options.challenge),options}}
 async verifyAuthentication(challengeId,response){const expectedChallenge=this.consumeChallenge(challengeId,'authenticate');if(!expectedChallenge||!response||typeof response.id!=='string')return null;const row=this.db.prepare('SELECT * FROM passkeys WHERE id=?').get(response.id);if(!row)return null;const {verifyAuthenticationResponse}=await this.sdk();const verified=await verifyAuthenticationResponse({response,expectedChallenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true,credential:{id:row.id,publicKey:unb64(row.public_key),counter:row.counter,transports:JSON.parse(row.transports||'[]')}});if(!verified.verified)return null;this.db.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(verified.authenticationInfo.newCounter,row.id);const token=crypto.randomBytes(32).toString('base64url');this.db.prepare('INSERT INTO sessions VALUES(?,?)').run(this.digest(token),Date.now()+this.sessionTTL);return token}
 digest(token){return crypto.createHash('sha256').update(token).digest('hex')}
 isSession(token){if(typeof token!=='string'||token.length>200)return false;const row=this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(this.digest(token));return !!row&&row.expires_at>Date.now()}
 logout(token){if(typeof token==='string')this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(this.digest(token))}
 close(){this.db.close()}
}