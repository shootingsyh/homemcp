import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CredentialVault,normalizeOrigin,credentialDomain,buildFillCode} from '../src/credentials.mjs';

test('strictly bind HTTPS website origin',()=>{
 assert.equal(normalizeOrigin('https://Example.COM/'),'https://example.com');
 for(const site of ['http://example.com/','https://example.com/path','https://example.com/?x=1','https://alice:pw@example.com/','not a url','https://localhost/'])
  assert.throws(()=>normalizeOrigin(site));
});
test('vault seals synthetic secret, binds origin and account; rejects overwrite',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-vault-'));
 const operations=[];
 const protector=async(_script,op,binding,secret)=>{
  operations.push({op,binding});
  return Buffer.from(op==='protect'?'sealed:'+secret.toString('utf8'):secret.toString('utf8').slice(7),'utf8');
 };
 const vault=new CredentialVault(folder,'mock.ps1',protector);
 try{
  assert.deepEqual(await vault.save({origin:'https://example.com',username:'alice',password:'test-only'}),{stored:true,origin:'example.com',username:'alice',replaced:false});
  assert.equal((await vault.secret('https://example.com','alice')).toString(),'test-only');
  await assert.rejects(vault.secret('https://example.org','alice'),/credential_not_found/);
  await assert.rejects(vault.save({origin:'https://example.com',username:'alice',password:'new-secret'}),/explicit_replace_required/);
  assert.equal((await vault.save({origin:'https://example.com',username:'alice',password:'new-secret',replace:true})).replaced,true);
  assert.notEqual(operations[0].binding,operations[1]?.differentAccount);
  assert.ok(!fs.readFileSync(path.join(folder,'credentials.sqlite')).includes(Buffer.from('test-only')));
 }finally{vault.close();fs.rmSync(folder,{recursive:true,force:true})}
});
test('fill checks live page origin before touching either selector',()=>{
 const code=buildFillCode('https://example.com','alice','test-only','input[name=user]','input[type=password]');
 assert.ok(code.includes("location.hostname!==v.site"));
 assert.ok(code.indexOf("location.hostname!==v.site")<code.indexOf('setter.call'));
 assert.ok(code.includes('selector_not_unique'));
 assert.ok(code.includes('not_password_field'));
 assert.throws(()=>buildFillCode('https://example.com','a','p','x','x'),/invalid_fill_target/);
});
test('secrets cannot enter standard approval persistence or logger',()=>{
 const server=fs.readFileSync('src/server.mjs','utf8');
 const branch=server.indexOf("if(name==='credential_save'||name==='credential_fill'||name==='credential_diagnose')");
 const approval=server.indexOf("if(name==='file_delete')",branch);
 assert.ok(branch>0 && approval>branch);
 assert.ok(!server.slice(branch,approval).includes('security.create('));
 assert.ok(!server.slice(branch,approval).includes("log.write("));
});

test('public suffix rules group login subdomains without mixing registrable domains',()=>{
 assert.equal(credentialDomain('https://login.delta.com'),'delta.com');
 assert.equal(credentialDomain('https://www.delta.com'),'delta.com');
 assert.equal(credentialDomain('https://login.example.co.uk'),'example.co.uk');
 assert.notEqual(credentialDomain('https://login.example.co.uk'),credentialDomain('https://other.co.uk'));
 assert.throws(()=>credentialDomain('https://co.uk'),/unregistrable_domain/);
});

test('credential failure classifications do not reveal upstream source',async()=>{
 const {classifyBrowserFillError}=await import('../src/credentials.mjs');
 assert.equal(classifyBrowserFillError({isError:true,content:[{type:'text',text:'Error: origin_mismatch'}]}),'origin_mismatch');
 assert.equal(classifyBrowserFillError({isError:true,content:[{type:'text',text:'Error: selector_not_unique'}]}),'selector_not_unique');
 assert.equal(classifyBrowserFillError({isError:false,content:[{type:'text',text:'### Result\n"HOMEMCP_CREDENTIAL_FILLED"'}]}),null);
 assert.equal(classifyBrowserFillError({isError:true,content:[{type:'text',text:'secret never echoed xyz'}]}),'browser_execution_unconfirmed');
});

test('success must be in evaluated result, not echoed browser code',async()=>{
 const {classifyBrowserFillError}=await import('../src/credentials.mjs');
 assert.equal(classifyBrowserFillError({isError:false,content:[{type:'text',text:'### Result\nundefined\n\n### Ran Playwright code\nreturn \"HOMEMCP_CREDENTIAL_FILLED\";'}]}),'browser_execution_unconfirmed');
});

test('credential diagnostic and fill helpers are imported by server',()=>{
 const s=fs.readFileSync('src/server.mjs','utf8');
 const line=s.split('\n').find(x=>x.startsWith('import {CredentialVault'));
 assert.match(line,/buildDiagnoseCode/);
 assert.match(line,/classifyBrowserFillError/);
});
