#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// Use the installed Host, including its normal authentication and tool routing.
export function localClient(config, fetcher = fetch) {
 if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !config.token)
  throw Error('local_configuration_missing');
 let session, id = 0;
 return async (method, params = {}, notification = false) => {
  const requestId = notification ? undefined : ++id;
  const response = await fetcher(`http://127.0.0.1:${config.port}/mcp`, {
   method:'POST', signal:AbortSignal.timeout(12000),
   headers:{'Content-Type':'application/json', Accept:'application/json, text/event-stream',
    Authorization:`Bearer ${config.token}`, ...(session ? {'Mcp-Session-Id':session} : {})},
   body:JSON.stringify({jsonrpc:'2.0', ...(notification ? {} : {id:requestId}), method, params})
  });
  if (!response.ok) throw Error('local_host_http_' + response.status);
  session = response.headers.get('mcp-session-id') || session;
  if (notification) return;
  const text = await response.text();
  let value;
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
   for (const frame of text.replaceAll('\r\n','\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { const item = JSON.parse(data); if (item.id === requestId) value = item; } catch {}
   }
  } else value = JSON.parse(text);
  if (!value || value.id !== requestId) throw Error('local_host_invalid_response');
  if (value.error) throw Error('desktop_call_failed');
  return value.result;
 };
}

export async function desktopSelfTest(request) {
 const checks = [];
 let tools;
 try {
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'desktop-self-test',version:'1'}});
  await request('notifications/initialized',{},true);
  tools = (await request('tools/list')).tools;
 } catch {
  return {ready:false, checks:[{name:'host',state:'failed',detail:'Local HomeMCP connection failed.',
   nextStep:'Start HomeMCP, then test again.'}]};
 }
 for (const [name, suffix] of [['screenshot','screenshot'],['window','snapshot']]) {
  const tool = tools?.find(t => t.name.toLowerCase() === 'desktop_' + suffix);
  try {
   if (!tool) throw Error('desktop_tool_missing');
   const result = await request('tools/call',{name:tool.name,arguments:{}});
   const pending = result?.approval_required || result?.approval_id || result?.approval_url ||
    result?.structuredContent?.approval_required || result?.structuredContent?.approval_id || result?.structuredContent?.approval_url ||
    result?._meta?.['io.modelcontextprotocol/model-immediate-response'];
   if (pending) throw Error('approval_required');
   if (result?.isError) throw Error('desktop_call_failed');
   if (result?.content?.some(c => c.type === 'text' && /^\s*Error capturing desktop state:/i.test(c.text || '')))
    throw Error('desktop_call_failed');
   if (name === 'screenshot' && !result?.content?.some(c => c.type === 'image' && c.data?.length > 0))
    throw Error('empty_screenshot');
   if (name === 'window' && !result?.content?.some(c => c.type === 'text' && c.text?.trim()))
    throw Error('empty_snapshot');
   // No pixels, window names, credentials or raw tool output enter the report.
   checks.push({name,state:'passed',detail:name === 'screenshot' ? 'Captured the desktop.' : 'Read desktop windows.'});
  } catch (error) {
   const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
   const code = timeout ? 'desktop_test_timeout' :
    ['desktop_tool_missing','approval_required','empty_screenshot','empty_snapshot'].includes(error.message)
     ? error.message : 'desktop_call_failed';
   checks.push({name,state:'failed',detail:code,
    nextStep:timeout ? 'Desktop inspection timed out. Check HomeMCP diagnostics before retrying; this does not confirm a missing permission.'
     : code === 'approval_required' ? 'Complete the HomeMCP approval, then test again.'
     : 'Unlock Windows and finish any pending system confirmation. Test again from your signed-in desktop. Elevated windows may require additional access.'});
   if (timeout) {
    if (name === 'screenshot') checks.push({name:'window',state:'skipped',detail:'Previous desktop request timed out.',nextStep:'Check HomeMCP diagnostics before retrying.'});
    break;
   }
  }
 }
 return {ready:checks.length === 2 && checks.every(c => c.state === 'passed'),checks};
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
 try {
  const configPath = process.argv[2] || path.join(process.env.LOCALAPPDATA,'HomeMCP','config.json');
  const config = JSON.parse((await fs.readFile(configPath,'utf8')).replace(/^\uFEFF/,''));
  console.log(JSON.stringify(await desktopSelfTest(localClient(config))));
 } catch {
  console.log(JSON.stringify({ready:false,checks:[{name:'host',state:'failed',detail:'Local configuration could not be read.',nextStep:'Complete HomeMCP setup and test again.'}]}));
 }
}
