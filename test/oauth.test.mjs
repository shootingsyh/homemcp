import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {HomeOAuth} from '../src/oauth.mjs';
const fixture=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-oauth-'));const auth=new HomeOAuth(dir,'https://mcp.example.org');return {auth,close(){auth.close();fs.rmSync(dir,{recursive:true,force:true})}}};
const form=x=>new URLSearchParams(x);
test('authorization code exchanges with S256 and one-time use',()=>{const f=fixture();try{const {auth}=f,client=auth.register({redirect_uris:['https://chat.example/callback']}).client_id,verifier='q'.repeat(43),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');const params=form({client_id:client,redirect_uri:'https://chat.example/callback',response_type:'code',code_challenge_method:'S256',code_challenge:challenge,resource:auth.resource,scope:'mcp offline_access'});const code=auth.issueCode(auth.validateAuth(params));const request={client_id:client,grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'https://chat.example/callback',resource:auth.resource};const tokens=auth.exchange(form(request));assert.equal(auth.authorized(tokens.access_token),true);assert.equal(tokens.expires_in,3600);assert.ok(tokens.refresh_token);assert.throws(()=>auth.exchange(form(request)),/invalid_grant/);}finally{f.close()}});
test('refresh rotates and reuse revokes the token family',()=>{const f=fixture();try{const {auth}=f,client=auth.register({redirect_uris:['https://chat.example/callback']}).client_id;const first=auth.issueTokens(client,auth.resource,'mcp offline_access'),next=auth.exchange(form({grant_type:'refresh_token',client_id:client,refresh_token:first.refresh_token,resource:auth.resource}));assert.ok(next.refresh_token);assert.notEqual(first.refresh_token,next.refresh_token);assert.throws(()=>auth.exchange(form({grant_type:'refresh_token',client_id:client,refresh_token:first.refresh_token,resource:auth.resource})),/invalid_grant/);assert.throws(()=>auth.exchange(form({grant_type:'refresh_token',client_id:client,refresh_token:next.refresh_token,resource:auth.resource})),/invalid_grant/)}finally{f.close()}});
test('client redirect validation and resource binding',()=>{const f=fixture();try{const {auth}=f;for(const uri of ['http://evil.example/','javascript:alert(1)','https://ok.example/#a'])assert.throws(()=>auth.register({redirect_uris:[uri]}));const client=auth.register({redirect_uris:['http://127.0.0.1:5678/callback']}).client_id;const p=form({client_id:client,redirect_uri:'http://127.0.0.1:5678/callback',response_type:'code',code_challenge_method:'S256',code_challenge:'a'.repeat(43),resource:'https://other.example/mcp'});assert.throws(()=>auth.validateAuth(p),/invalid_target/);assert.equal(auth.metadata().scopes_supported.includes('offline_access'),true)}finally{f.close()}});

test('separate installation domains have separate OAuth issuer and resource',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-oauth-domains-'));try{const a=new HomeOAuth(d,'https://alice.example.org'),b=new HomeOAuth(d,'https://bob.example.org');assert.equal(a.metadata().issuer,'https://alice.example.org');assert.equal(b.metadata().issuer,'https://bob.example.org');assert.notEqual(a.protectedMetadata().resource,b.protectedMetadata().resource);const access=a.issueTokens('a',a.resource,'mcp').access_token;assert.equal(a.authorized(access),true);assert.equal(b.authorized(access),false);a.close();b.close()}finally{fs.rmSync(d,{recursive:true,force:true})}});

test('OAuth authorization accepts absent, issuer or canonical resource only',()=>{const f=fixture();try{const {auth}=f;const client=auth.register({redirect_uris:['http://127.0.0.1:5678/callback']}).client_id;const params={client_id:client,redirect_uri:'http://127.0.0.1:5678/callback',response_type:'code',code_challenge_method:'S256',code_challenge:'a'.repeat(43)};for(const resource of [undefined,auth.issuer,auth.resource]){const p=form({...params,...(resource===undefined?{}:{resource})});assert.equal(auth.validateAuth(p).resource,auth.resource)}for(const resource of ['https://evil.example/mcp',auth.issuer+'/wrong',auth.resource+'/'])assert.throws(()=>auth.validateAuth(form({...params,resource})),/invalid_target/)}finally{f.close()}});

test('token exchange normalizes missing and issuer resources for codes and refresh',()=>{
 const f=fixture();try{
  const {auth}=f,client=auth.register({redirect_uris:['https://chat.example/callback']}).client_id;
  const verifier='v'.repeat(43),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
  for(const resource of [undefined,auth.issuer,auth.resource]){
   const authorize=form({client_id:client,redirect_uri:'https://chat.example/callback',response_type:'code',code_challenge_method:'S256',code_challenge:challenge,scope:'mcp offline_access'});
   const code=auth.issueCode(auth.validateAuth(authorize));
   const base={client_id:client,grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'https://chat.example/callback'};
   const grant=form({...base,...(resource===undefined?{}:{resource})});
   const first=auth.exchange(grant);
   assert.equal(auth.authorized(first.access_token),true);
   const refreshed=auth.exchange(form({client_id:client,grant_type:'refresh_token',refresh_token:first.refresh_token,...(resource===undefined?{}:{resource})}));
   assert.equal(auth.authorized(refreshed.access_token),true);
   assert.throws(()=>auth.exchange(form({...base,resource:'https://outside.example/mcp'})),/invalid_target/);
   assert.throws(()=>auth.exchange(form({client_id:client,grant_type:'refresh_token',refresh_token:refreshed.refresh_token,resource:auth.issuer+'/other'})),/invalid_target/);
   assert.equal(auth.authorized(refreshed.access_token),true);
  }
 }finally{f.close()}
});
