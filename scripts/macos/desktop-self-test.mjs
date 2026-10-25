#!/usr/bin/env node
// Exercise the existing Manager process: a new helper would test the wrong TCC identity.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function callDesktop(socketPath, tool, timeoutMs = 8000) {
 return new Promise((resolve, reject) => {
  let output = '', finished = false;
  const socket = net.createConnection(socketPath);
  const finish = (error, value) => {
   if (finished) return;
   finished = true; clearTimeout(timer); socket.destroy();
   if (error) reject(error); else resolve(value);
  };
  const timer = setTimeout(() => finish(Error('desktop_test_timeout')), timeoutMs);
  socket.on('connect', () => socket.end(JSON.stringify({tool, arguments:{}}) + '\n'));
  socket.on('data', data => {
   output += data.toString('utf8');
   if (output.length > 24 * 1024 * 1024) finish(Error('desktop_response_too_large'));
  });
  socket.on('error', () => finish(Error('manager_unavailable')));
  socket.on('end', () => {
   try { finish(null, JSON.parse(output)); }
   catch { finish(Error('invalid_desktop_response')); }
  });
 });
}

export async function desktopSelfTest(call) {
 const checks = [];
 let permissions;
 try { permissions = await call('desktop_permissions'); }
 catch (error) {
  return {ready:false, checks:[{name:'manager', state:'failed', detail:error.message,
   nextStep:'Open HomeMCP Manager and select Test Desktop Again.'}]};
 }
 for (const [name, tool, permission, settings] of [
  ['screenshot', 'desktop_screenshot', 'screen_recording', 'Screen & System Audio Recording'],
  ['window', 'desktop_snapshot', 'accessibility', 'Accessibility']
 ]) {
  if (permissions[permission] !== true) {
   checks.push({name, state:'permission_required', detail:permission + '_permission_required',
    nextStep:`Enable HomeMCP Manager in Privacy & Security > ${settings}. Finish any system confirmation and reopen Manager if requested, then test again.`});
   continue;
  }
  try {
   const result = await call(tool);
   if (result.error) throw Error(result.error);
   if (name === 'screenshot' && !(result.width > 0 && result.height > 0 &&
       typeof result.image_base64 === 'string' && result.image_base64.length > 0)) {
    throw Error('empty_screenshot');
   }
   if (name === 'window' && !(typeof result.app === 'string' && result.app.trim())) {
    throw Error('no_focused_application');
   }
   // Discard pixels and window titles. Persist no desktop content.
   checks.push({name, state:'passed', detail:name === 'screenshot'
    ? `Captured ${result.width} × ${result.height}` : 'Read the foreground application'});
  } catch (error) {
   checks.push({name, state:'failed', detail:error.message,
    nextStep:error.message === 'no_focused_application'
     ? 'Focus a normal application such as Finder, then test again.'
     : 'Finish any pending macOS confirmation. Reopen Manager if requested, then test again.'});
  }
 }
 return {ready:checks.every(check => check.state === 'passed'), checks};
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
 const socketPath = process.env.HOMEMCP_MAC_DESKTOP_SOCKET ||
  path.join(os.homedir(), 'Library', 'Application Support', 'HomeMCP', 'desktop.sock');
 console.log(JSON.stringify(await desktopSelfTest(tool => callDesktop(socketPath, tool))));
}
