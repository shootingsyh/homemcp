import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ApprovalStore,policyFor,adminAuthorized} from '../src/security.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-security-'));
const cleanup=(store,dir)=>{store.shutdown();fs.rmSync(dir,{recursive:true,force:true})};
test('policy defaults to deny and supports ask',()=>{assert.equal(policyFor('x'),'deny');assert.equal(policyFor('x',{x:'ask'}),'ask');assert.throws(()=>policyFor('x',{x:'bad'}))});
test('admin secret distinct from client bearer',()=>{assert.equal(adminAuthorized('Bearer client','admin'),false);assert.equal(adminAuthorized('Bearer admin','admin'),true)});
test('pending requires approval; executes stored arguments once',()=>{
 const dir=temp(),db=new ApprovalStore(dir);
 const original={url:'https://example.com'},pending=db.create('browser_navigate',original,'Navigate example.com','key-123456789');
 assert.equal(pending.status,'pending');assert.equal(db.claim(pending.id,pending.arguments_hash),null);
 assert.equal(db.complete(pending.id,'approved'),'approved');
 assert.deepEqual(db.claim(pending.id,pending.arguments_hash),{tool:'browser_navigate',args:original});
 assert.equal(db.claim(pending.id,pending.arguments_hash),null);
 assert.equal(db.finish(pending.id,{success:true}),true);
 assert.deepEqual(db.result(pending.id).result,{success:true});
 assert.equal(db.claim(pending.id,pending.arguments_hash),null);cleanup(db,dir);
});
test('idempotency key binds exact parameters',()=>{
 const dir=temp(),db=new ApprovalStore(dir),key='unique-key-123456';
 const a=db.create('browser_navigate',{url:'https://one.example'},'Go one',key);
 assert.equal(db.create('browser_navigate',{url:'https://one.example'},'Go one',key).id,a.id);
 assert.throws(()=>db.create('browser_navigate',{url:'https://two.example'},'Go two',key),/conflict/);
 cleanup(db,dir);
});
test('denial and expiry fail closed',async()=>{
 const dir=temp(),db=new ApprovalStore(dir,{timeoutMs:10});
 const a=db.create('browser_navigate',{url:'https://one.example'},'Go one');
 assert.equal(db.complete(a.id,'rejected'),'rejected');assert.equal(db.claim(a.id,a.arguments_hash),null);
 const b=db.create('browser_navigate',{url:'https://two.example'},'Go two');
 await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(db.get(b.id).status,'expired');assert.equal(db.complete(b.id,'approved'),false);
 cleanup(db,dir);
});
test('restart preserves pending and treats in-flight as unknown',()=>{
 const dir=temp();let db=new ApprovalStore(dir),a=db.create('browser_navigate',{url:'https://one.example'},'Go one');
 db.shutdown();db=new ApprovalStore(dir);assert.equal(db.get(a.id).status,'pending');
 assert.equal(db.complete(a.id,'approved'),'approved');assert.ok(db.claim(a.id,a.arguments_hash));
 db.shutdown();db=new ApprovalStore(dir);
 assert.equal(db.get(a.id).status,'outcome_unknown');assert.equal(db.claim(a.id,a.arguments_hash),null);
 cleanup(db,dir);
});
test('automatic approval dispatch and manual resume race: only one claim wins',async()=>{
 const dir=temp(),db=new ApprovalStore(dir);
 try{
  const item=db.create('file_delete',{path:'synthetic-only'},'Synthetic test');
  assert.equal(db.claim(item.id,item.arguments_hash),null);
  assert.equal(db.complete(item.id,'approved'),'approved');
  const first=db.claim(item.id,item.arguments_hash);
  const second=db.claim(item.id,item.arguments_hash);
  assert.ok(first);
  assert.equal(second,null);
  assert.equal(db.complete(item.id,'approved'),false);
  assert.equal(db.claim(item.id,'tampered'),null);
  assert.equal(db.finish(item.id,{deleted:true}),true);
  assert.equal(db.claim(item.id,item.arguments_hash),null);
  assert.equal(db.result(item.id).status,'completed');
 }finally{cleanup(db,dir)}
});
