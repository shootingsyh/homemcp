import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

test('mac desktop adapter discovers tools and returns screenshot as MCP image',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homemcp-mac-desktop-'));
 const mock=path.join(dir,'mock-helper');
 fs.writeFileSync(mock,'#!/usr/bin/env node\nlet s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const req=JSON.parse(s);console.log(JSON.stringify(req.tool==="desktop_screenshot"?{image_base64:"aGVsbG8=",width:1,height:1}:{ok:true,tool:req.tool}))})\n',{mode:0o755});
 const child=spawn(process.execPath,['scripts/macos/desktop-worker.mjs'],{env:{...process.env,HOMEMCP_MAC_DESKTOP_HELPER:mock},stdio:['pipe','pipe','pipe']});
 const it=readline.createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const send=(id,method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
 try{
  send(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal(JSON.parse((await it.next()).value).id,1);
  send(2,'tools/list');
  const list=JSON.parse((await it.next()).value).result.tools.map(x=>x.name);
  for(const name of ['desktop_permissions','desktop_screenshot','desktop_snapshot','desktop_click','desktop_type','desktop_scroll','desktop_shortcut'])assert.ok(list.includes(name),name);
  send(3,'tools/call',{name:'desktop_screenshot',arguments:{}});
  const screenshot=JSON.parse((await it.next()).value).result;
  assert.equal(screenshot.content[0].type,'image');
  assert.equal(screenshot.content[0].mimeType,'image/png');
  assert.equal(screenshot.content[0].data,'aGVsbG8=');
  send(4,'tools/call',{name:'desktop_click',arguments:{x:1,y:2}});
  assert.equal(JSON.parse((await it.next()).value).result.structuredContent.ok,true);
 }finally{child.kill('SIGTERM');fs.rmSync(dir,{recursive:true,force:true})}
});
