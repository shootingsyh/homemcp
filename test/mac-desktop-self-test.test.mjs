import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {desktopSelfTest, callDesktop} from '../scripts/macos/desktop-self-test.mjs';

test('grants alone are insufficient; screenshot failure stays failed', async () => {
 const calls = [];
 const report = await desktopSelfTest(async tool => {
  calls.push(tool);
  if (tool === 'desktop_permissions') return {screen_recording:true, accessibility:true};
  if (tool === 'desktop_screenshot') return {error:'capture_failed'};
  return {app:'Finder', window:'Private title'};
 });
 assert.equal(report.ready, false);
 assert.equal(report.checks[0].state, 'failed');
 assert.equal(report.checks[1].state, 'passed');
 assert.deepEqual(calls, ['desktop_permissions', 'desktop_screenshot', 'desktop_snapshot']);
 assert.doesNotMatch(JSON.stringify(report), /Private title/);
});

test('missing permissions skip protected actions and explain final system confirmation', async () => {
 const report = await desktopSelfTest(async tool => {
  assert.equal(tool, 'desktop_permissions');
  return {screen_recording:false, accessibility:false};
 });
 assert.equal(report.ready, false);
 assert.ok(report.checks.every(c => c.state === 'permission_required'));
 assert.match(report.checks[0].nextStep, /system confirmation/);
});

test('actual captures pass without retaining pixels or titles', async () => {
 const report = await desktopSelfTest(async tool => ({
  desktop_permissions:{screen_recording:true, accessibility:true},
  desktop_screenshot:{width:1680, height:1050, image_base64:'private-pixels'},
  desktop_snapshot:{app:'Finder', window:'private-title'}
 })[tool]);
 assert.equal(report.ready, true);
 assert.doesNotMatch(JSON.stringify(report), /private-/);
});

test('no focused application prompts a retry rather than declaring success', async () => {
 const report = await desktopSelfTest(async tool => ({
  desktop_permissions:{screen_recording:true, accessibility:true},
  desktop_screenshot:{width:1,height:1,image_base64:'png'},
  desktop_snapshot:{error:'no_focused_application'}
 })[tool]);
 assert.equal(report.ready, false);
 assert.match(report.checks[1].nextStep, /Finder/);
});

test('socket client handles fragmented JSON and bounds a stalled request', {skip:process.platform === 'win32'}, async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmc-test-'));
 const socketPath = path.join(dir, 'desktop.sock');
 const clients = new Set();
 const server = net.createServer({allowHalfOpen:true}, socket => {
  clients.add(socket); socket.on('close', () => clients.delete(socket));
  let input = '';
  socket.on('data', data => { input += data; });
  socket.on('end', () => {
   if (JSON.parse(input).tool === 'desktop_permissions') {
    socket.write('{"accessibility":'); socket.end('true}');
   }
  });
 });
 t.after(async () => {
  for (const client of clients) client.destroy();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, {recursive:true,force:true});
 });
 await new Promise(resolve => server.listen(socketPath, resolve));
 assert.deepEqual(await callDesktop(socketPath, 'desktop_permissions', 500), {accessibility:true});
 await assert.rejects(callDesktop(socketPath, 'desktop_snapshot', 40), /desktop_test_timeout/);
});
