import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {stopWorker} from '../src/process-lifecycle.mjs';

test('Unix stop sends SIGTERM',async()=>{
 let received='';
 await stopWorker({kill:(signal)=>received=signal},{platform:'linux'});
 assert.equal(received,'SIGTERM');
});
test('Windows stop uses only target PID and child tree',async()=>{
 let command,args;
 await stopWorker({pid:12345},{platform:'win32',launch:(c,a)=>{
  command=c;args=a;
  const process=new EventEmitter();
  queueMicrotask(()=>process.emit('exit',0));
  return process;
 }});
 assert.equal(command,'taskkill.exe');
 assert.deepEqual(args,['/PID','12345','/T','/F']);
});
