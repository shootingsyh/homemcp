import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const get=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('Mac package builds and installs Keychain helper at Host configured path',()=>{
 const build=get('scripts/macos/build-manager.sh');
 const pkg=get('scripts/macos/package.sh');
 const launch=get('scripts/macos/write-launch-agent.mjs');
 const provision=get('scripts/macos/provision.mjs');
 assert.match(build,/keychain-helper\.swift/);
 assert.match(build,/build\/macos-keychain\/home-mcp-keychain/);
 assert.match(pkg,/cp "\$ROOT\/build\/macos-keychain\/home-mcp-keychain" "\$RESOURCES\/native\/macos\/home-mcp-keychain"/);
 assert.match(launch,/native.*macos.*home-mcp-keychain/);
 assert.match(provision,/credentialVaultEnabled:true/);
});
