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
 this.rpID=rpID;this.origin=origin;this.challengeTTL=challengeTTL;this.sessionTTL=sessionTTL;
 }
 async sdk(){return import('@simplewebauthn/server')}
 storeChallenge(kind,challenge){const id=crypto.randomUUID();this.db.prepare('INSERT INTO challenges VALUES(?,?,?,?)').run(id,kind,challenge,Date.now()+this.challengeTTL);return id}
 consumeChallenge(id,kind){if(typeof id!=='string'||!/^[a-f\d-]{36}$/.test(id))return null;const row=this.db.prepare('SELECT * FROM challenges WHERE id=?').get(id);this.db.prepare('DELETE FROM challenges WHERE id=?').run(id);if(!row||row.kind!==kind||row.expires_at<=Date.now())return null;return row.challenge}
 registered(){return this.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n>0}
 async registrationOptions(){const {generateRegistrationOptions}=await this.sdk();const options=await generateRegistrationOptions({rpName:'HomeMCP',rpID:this.rpID,userName:'HomeMCP owner',userID:crypto.randomBytes(32),attestationType:'none',authenticatorSelection:{userVerification:'required',residentKey:'preferred'},excludeCredentials:this.db.prepare('SELECT id FROM passkeys').all().map(x=>({id:x.id}))});return {challengeId:this.storeChallenge('register',options.challenge),options}}
 async verifyRegistration(challengeId,response){const expectedChallenge=this.consumeChallenge(challengeId,'register');if(!expectedChallenge)return false;const {verifyRegistrationResponse}=await this.sdk();const result=await verifyRegistrationResponse({response,expectedChallenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true});if(!result.verified||!result.registrationInfo)return false;const {credential}=result.registrationInfo;this.db.prepare('INSERT INTO passkeys(id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?)').run(credential.id,b64(credential.publicKey),credential.counter,JSON.stringify(credential.transports||[]),Date.now());return true}
 async authenticationOptions(){if(!this.registered())throw new Error('no_passkey_registered');const {generateAuthenticationOptions}=await this.sdk();const options=await generateAuthenticationOptions({rpID:this.rpID,userVerification:'required',allowCredentials:this.db.prepare('SELECT id,transports FROM passkeys').all().map(x=>({id:x.id,transports:JSON.parse(x.transports||'[]')}))});return {challengeId:this.storeChallenge('authenticate',options.challenge),options}}
 async verifyAuthentication(challengeId,response){const expectedChallenge=this.consumeChallenge(challengeId,'authenticate');if(!expectedChallenge||!response||typeof response.id!=='string')return null;const row=this.db.prepare('SELECT * FROM passkeys WHERE id=?').get(response.id);if(!row)return null;const {verifyAuthenticationResponse}=await this.sdk();const verified=await verifyAuthenticationResponse({response,expectedChallenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true,credential:{id:row.id,publicKey:unb64(row.public_key),counter:row.counter,transports:JSON.parse(row.transports||'[]')}});if(!verified.verified)return null;this.db.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(verified.authenticationInfo.newCounter,row.id);const token=crypto.randomBytes(32).toString('base64url');this.db.prepare('INSERT INTO sessions VALUES(?,?)').run(this.digest(token),Date.now()+this.sessionTTL);return token}
 digest(token){return crypto.createHash('sha256').update(token).digest('hex')}
 isSession(token){if(typeof token!=='string'||token.length>200)return false;const row=this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(this.digest(token));return !!row&&row.expires_at>Date.now()}
 logout(token){if(typeof token==='string')this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(this.digest(token))}
 close(){this.db.close()}
}