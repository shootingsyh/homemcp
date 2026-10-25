import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {managedOrigin,checkedCheckout,enrollOrResume,nextDomainConfig,switchDomainFiles,rollbackDomainFiles} from '../src/managed-domain.mjs';
import {PasskeyManager} from '../src/passkeys.mjs';

test('managed domains and checkout origins reject lookalikes and arbitrary routes',()=>{
 assert.equal(managedOrigin('https://alice.tunnel.homemcp.si').username,'alice');
 for(const value of ['http://alice.tunnel.homemcp.si','https://alice.tunnel.homemcp.si.evil.test','https://u:p@alice.tunnel.homemcp.si','https://alice.tunnel.homemcp.si/path','https://alice.tunnel.homemcp.si?next=x'])assert.throws(()=>managedOrigin(value));
 assert.equal(checkedCheckout('https://checkout.stripe.com/c/pay/cs_live_example'),'https://checkout.stripe.com/c/pay/cs_live_example');
 assert.throws(()=>checkedCheckout('https://checkout.stripe.com.evil.test/c/pay/cs_live_example'));
});
test('existing registration resumes without creating a second Checkout session',async()=>{
 let calls=0;const client={enroll:async()=>{calls++;throw Error('must not enroll')}};
 const result=await enrollOrResume({username:'alice',plan:'monthly',enrollment:{id:'private-id',username:'alice',checkout_url:'https://checkout.stripe.com/c/pay/cs_live_example'},client,markAttempt:()=>assert.fail('second attempt'),persist:()=>assert.fail('overwrite')});
 assert.equal(result.resumed,true);assert.equal(calls,0);
});
test('enrollment persists capability before malformed response errors and POST errors are not retried',async()=>{
 let calls=0,saved;
 const options={username:'alice',plan:'monthly',client:{enroll:async()=>{calls++;return {enrollment_id:'private-id',status:'pending_payment',checkout_url:'https://evil.test'}}},markAttempt:()=>{},persist:e=>saved=e};
 await assert.rejects(enrollOrResume(options));assert.equal(calls,1);assert.equal(saved.id,'private-id');
 calls=0;options.client={enroll:async()=>{calls++;throw Error('network error')}};
 await assert.rejects(enrollOrResume(options));assert.equal(calls,1);
});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-domains-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),profile=path.join(root,'profile');
 for(const dir of [path.join(home,'data','oracle-tunnel'),path.join(profile,'data','oracle-tunnel')])fs.mkdirSync(dir,{recursive:true});
 const config={publicUrl:'https://old.tunnel.homemcp.si',dataDir:path.join(home,'data'),token:'keep-this-token',security:{adminToken:'keep-admin',rpID:'old.tunnel.homemcp.si',rpOrigin:'https://old.tunnel.homemcp.si'},oauth:{enabled:true}};
 fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(config));
 fs.writeFileSync(path.join(home,'network-setup.json'),JSON.stringify({mode:'managed',url:config.publicUrl}));
 fs.writeFileSync(path.join(home,'data','passkeys.sqlite'),'existing Passkey records');
 fs.writeFileSync(path.join(home,'data','oauth.sqlite'),'existing OAuth sessions');
 fs.writeFileSync(path.join(home,'data','oracle-tunnel','credential.dpapi'),'old protected credentials');
 fs.writeFileSync(path.join(profile,'data','oracle-tunnel','credential.dpapi'),'new protected credentials');
 return {home,profile,config};
}
test('domain switch and rollback preserve the original Passkeys, OAuth, and Host tokens',t=>{
 const {home,profile}=fixture(t),configBefore=fs.readFileSync(path.join(home,'config.json'));
 switchDomainFiles({home,profile,origin:'https://new.tunnel.homemcp.si'});
 const current=JSON.parse(fs.readFileSync(path.join(home,'config.json')));
 assert.equal(current.publicUrl,'https://new.tunnel.homemcp.si');assert.equal(current.security.rpID,'new.tunnel.homemcp.si');assert.equal(current.token,'keep-this-token');
 assert.equal(fs.readFileSync(path.join(home,'data','oracle-tunnel','credential.dpapi'),'utf8'),'new protected credentials');
 rollbackDomainFiles(home);
 assert.deepEqual(fs.readFileSync(path.join(home,'config.json')),configBefore);
 assert.equal(fs.readFileSync(path.join(home,'data','oracle-tunnel','credential.dpapi'),'utf8'),'old protected credentials');
 for(const [file,text] of [['passkeys.sqlite','existing Passkey records'],['oauth.sqlite','existing OAuth sessions']])assert.equal(fs.readFileSync(path.join(home,'data',file),'utf8'),text);
 assert.throws(()=>rollbackDomainFiles(home));
});
test('partial file failure restores both the old domain and protected credentials',t=>{
 const {home,profile}=fixture(t),before=fs.readFileSync(path.join(home,'config.json'));
 let fail=true;const io={...fs,renameSync:(from,to)=>{if(fail&&to===path.join(home,'network-setup.json')){fail=false;throw Error('simulated disk error')}return fs.renameSync(from,to)}};
 assert.throws(()=>switchDomainFiles({home,profile,origin:'https://new.tunnel.homemcp.si',io}),/simulated disk error/);
 assert.deepEqual(fs.readFileSync(path.join(home,'config.json')),before);
 assert.equal(fs.readFileSync(path.join(home,'data','oracle-tunnel','credential.dpapi'),'utf8'),'old protected credentials');
 assert.equal(fs.readFileSync(path.join(home,'data','passkeys.sqlite'),'utf8'),'existing Passkey records');
});
test('missing target credential cannot mutate the current domain',t=>{
 const {home,profile}=fixture(t),before=fs.readFileSync(path.join(home,'config.json'));
 fs.unlinkSync(path.join(profile,'data','oracle-tunnel','credential.dpapi'));
 assert.throws(()=>switchDomainFiles({home,profile,origin:'https://new.tunnel.homemcp.si'}),/claimed_credential_required/);
 assert.deepEqual(fs.readFileSync(path.join(home,'config.json')),before);
});
test('new domain has no trusted devices and switching back reuses the original registration',t=>{
 const {home,config}=fixture(t);
 fs.unlinkSync(path.join(home,'data','passkeys.sqlite'));
 const old=new PasskeyManager(config.dataDir,{rpID:'old.tunnel.homemcp.si',origin:config.publicUrl});
 old.db.prepare('INSERT INTO passkeys(id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?)').run('old-device','cHVibGlj',0,'[]',Date.now());
 assert.equal(old.registered(),true);old.close();
 const changed=nextDomainConfig(config,'https://new.tunnel.homemcp.si');
 const fresh=new PasskeyManager(changed.security.passkeyDataDir,{rpID:changed.security.rpID,origin:changed.publicUrl});
 assert.equal(fresh.registered(),false);fresh.close();
 const restored=nextDomainConfig(changed,config.publicUrl);
 assert.equal(restored.security.passkeyDataDir,config.dataDir);
 const existing=new PasskeyManager(restored.security.passkeyDataDir,{rpID:restored.security.rpID,origin:restored.publicUrl});
 assert.equal(existing.registered(),true);assert.equal(existing.list()[0].id,'old-device');existing.close();
});
