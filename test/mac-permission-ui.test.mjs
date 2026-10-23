import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const helper=fs.readFileSync(new URL('../native/macos/desktop-helper.swift',import.meta.url),'utf8');
const manager=fs.readFileSync(new URL('../native/macos/Manager/HomeMCPManagerApp.swift',import.meta.url),'utf8');
test('screen capture permission has explicit request entry point',()=>{
 assert.match(helper,/desktop_request_screen_recording/);
 assert.match(helper,/CGRequestScreenCaptureAccess\(\)/);
 assert.match(helper,/SCShareableContent\.current/);
 assert.match(manager,/Button\("Request Screen Recording"\)/);
 assert.match(manager,/ScriptRunner\.execute\(helper/);
 assert.match(manager,/Privacy_ScreenCapture/);
});
