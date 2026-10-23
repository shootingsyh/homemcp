import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../web/approval.html',import.meta.url),'utf8');
const js=fs.readFileSync(new URL('../web/approval.js',import.meta.url),'utf8');
test('phone QR enrollment has a single primary action',()=>{
 assert.match(html,/id="register">Connect this device/);
 assert.match(html,/id="enrollment" hidden/);
 assert.match(html,/id="actions" hidden/);
 assert.match(js,/params\.has\('enroll'\)/);
 assert.match(js,/byId\('actions'\)\.hidden=true/);
 assert.match(js,/byId\('enrollment'\)\.hidden=false/);
 assert.match(js,/Your Passkey is ready/);
});
