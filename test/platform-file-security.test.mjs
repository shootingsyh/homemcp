import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {validateDeletionPath} from '../src/platform/file-security.mjs';

test('POSIX file deletion allows regular file within home',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-files-'));
 try {
  const file=path.join(root,'inside.txt');fs.writeFileSync(file,'ok');
  assert.equal(validateDeletionPath(file,{platform:'darwin',home:root}),file);
  assert.throws(()=>validateDeletionPath('/etc/hosts',{platform:'darwin',home:root}),/file_outside_user_home/);
  const symlink=path.join(root,'link');fs.symlinkSync(file,symlink);
  assert.throws(()=>validateDeletionPath(symlink,{platform:'darwin',home:root}),/not_regular_file/);
 }finally{fs.rmSync(root,{force:true,recursive:true})}
});
test('macOS credential protector fails closed without a trusted helper',async()=>{
 const {createCredentialProtector}=await import('../src/platform/credential-protector.mjs');
 await assert.rejects(createCredentialProtector('darwin')('', 'invalid','account',Buffer.from('secret')),/invalid_protection_operation/);
});
