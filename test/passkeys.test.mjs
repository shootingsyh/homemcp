import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {PasskeyManager} from '../src/passkeys.mjs';
test('passkey challenges are consumed exactly once',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-passkey-'));const p=new PasskeyManager(dir);const a=p.storeChallenge('register','random_challenge');assert.equal(p.consumeChallenge(a,'authenticate'),null);assert.equal(p.consumeChallenge(a,'register'),null);const b=p.storeChallenge('authenticate','challenge_2');assert.equal(p.consumeChallenge(b,'authenticate'),'challenge_2');assert.equal(p.consumeChallenge(b,'authenticate'),null);assert.equal(p.isSession('not-a-real-session'),false);p.close();fs.rmSync(dir,{force:true,recursive:true})});
test('expired challenges and unregistered status fail closed',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-passkey-'));const p=new PasskeyManager(dir,{challengeTTL:-1});assert.equal(p.registered(),false);const a=p.storeChallenge('register','challenge');assert.equal(p.consumeChallenge(a,'register'),null);assert.equal(p.isSession('anything'),false);p.close();fs.rmSync(dir,{force:true,recursive:true})});
test('enrollment invites are single-use and expire',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-passkey-'));
 const p=new PasskeyManager(dir);
 const first=p.issueEnrollmentInvite();
 assert.equal(p.validInvite(first.token),true);
 assert.equal(p.validInvite('wrong_token'),false);
 assert.equal(p.validInvite(undefined),false);
 p.db.prepare('UPDATE enrollment_invites SET consumed_at=? WHERE digest=?').run(Date.now(),p.digest(first.token));
 assert.equal(p.validInvite(first.token),false);
 const second=p.issueEnrollmentInvite();
 p.db.prepare('UPDATE enrollment_invites SET expires_at=? WHERE digest=?').run(Date.now()-1,p.digest(second.token));
 assert.equal(p.validInvite(second.token),false);
 p.close();fs.rmSync(dir,{recursive:true,force:true});
});
