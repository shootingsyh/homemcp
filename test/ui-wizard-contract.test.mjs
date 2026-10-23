import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mac=fs.readFileSync(new URL('../native/macos/Manager/HomeMCPManagerApp.swift',import.meta.url),'utf8');
const win=fs.readFileSync(new URL('../native/Manager/Program.cs',import.meta.url),'utf8');

test('macOS wizard gates the Passkey step behind tunnel verification',()=>{
 assert.match(mac,/else if step == 1[\s\S]*?runScript\("setup\.mjs", \["byot", domain\]\) \{ _, _ in step = 2 \}/);
 assert.match(mac,/else \{\s*Text\("Connect your phone"\)/);
 assert.match(mac,/if state\.complete \{\s*completed = true/);
 assert.match(mac,/passkeyCount/);
 assert.match(mac,/Restart Setup Wizard/);
 assert.match(mac,/completed = false\s*step = 0/);
});
test('Windows wizard has distinct pages and checks Passkey enrollment before finish',()=>{
 assert.match(win,/void OpenSetupWizard\(\)/);
 assert.match(win,/Choose connection/);
 assert.match(win,/Verify your tunnel/);
 assert.match(win,/Register Passkey/);
 assert.match(win,/await VerifyByotConnection\(\)/);
 assert.match(win,/if\(!status\.hasOrigin\|\|status\.passkeys<1\)throw/);
 assert.match(win,/File\.WriteAllTextAsync\(Path\.Combine\(dir,"setup-complete\.marker"\)/);
});
test('Windows reset leaves host credentials intact and reopens wizard',()=>{
 const start=win.indexOf('var wizard=new Button{Text="Restart Setup Wizard');
 const end=win.indexOf('content.Controls.Add(wizard);',start);
 assert.ok(start>0&&end>start);
 const reset=win.slice(start,end);
 assert.match(reset,/setup-complete\.marker/);
 assert.match(reset,/OpenSetupWizard\(\)/);
 assert.doesNotMatch(reset,/File\.Delete\(ConfigPath\)/);
 const withoutCompletionMarker=reset.replace(/File\.Delete\(Path\.Combine\(dir,"setup-complete\.marker"\)\);/g,"");
 assert.doesNotMatch(withoutCompletionMarker,/File\.Delete\(|Directory\.Delete\(/);
});
test('both smoke modes avoid real Host startup and render isolated wizard pages',()=>{
 assert.match(win,/HOMEMCP_UI_SMOKE/);
 assert.match(win,/wizard_passkey_visible_too_early/);
 assert.match(mac,/HOMEMCP_UI_SMOKE_PAGE/);
 assert.match(mac,/HOMEMCP_UI_READY/);
});

test('macOS dashboard offers separate ChatGPT walkthrough and Muse prompt',()=>{
 assert.match(mac,/Button\("Connect ChatGPT · Step by step"\)/);
 assert.match(mac,/Button\("Connect Muse · Copy prompt"\)/);
 assert.match(mac,/Add custom MCP server/);
 assert.match(mac,/Create as a plugin/);
 assert.match(mac,/Copy Muse setup prompt/);
 assert.match(mac,/Transport: Streamable HTTP/);
 assert.match(mac,/json\["publicUrl"\]/);
 assert.match(mac,/Text\("Your MCP endpoint"\)/);
 assert.match(mac,/\+ "\/mcp"/);
});
