import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HomeOAuth} from '../src/oauth.mjs';
test('Windows DPAPI key persists encrypted retry across Host restart', {skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oauth-dpapi-smoke-'));
 try{
  let o=new HomeOAuth(dir,'https://win.example.org');
  const client=o.register({redirect_uris:['https://example.org/callback']}).client_id;
  const first=o.issueTokens(client,o.resource,'mcp offline_access');
  const req=new URLSearchParams({client_id:client,grant_type:'refresh_token',refresh_token:first.refresh_token,resource:o.resource});
  const second=o.exchange(req);
  assert.deepEqual(o.exchange(req),second);
  assert.equal(o.lastRefreshOutcome,'replayed');
  o.close();
  assert.ok(fs.existsSync(path.join(dir,'oauth-retry-key-v1.dpapi')));
  o=new HomeOAuth(dir,'https://win.example.org');
  assert.deepEqual(o.exchange(req),second);
  assert.equal(o.lastRefreshOutcome,'replayed');
  o.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
