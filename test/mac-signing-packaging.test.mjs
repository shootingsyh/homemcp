import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('macOS signed build signs embedded executables before outer app and packaging',()=>{
 const script=read('scripts/macos/sign-app.sh');
 const pkg=read('scripts/macos/package.sh');
 assert.match(script,/HOMEMCP_CODESIGN_IDENTITY/);
 assert.match(script,/HomeMCP\.Desktop/);
 assert.match(script,/codesign --verify --deep --strict/);
 assert.ok(script.indexOf('sign_one "$APP/Contents/MacOS/HomeMCP.Desktop"')<script.indexOf('codesign --force --sign "$IDENTITY" --options runtime "$APP"'));
 assert.match(pkg,/sign-app\.sh/);
 assert.ok(pkg.indexOf('sign-app.sh')<pkg.indexOf('pkgbuild --scripts'));
});
