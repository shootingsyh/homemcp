// Enumerate upstream tools without invoking browser/desktop actions.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [candidate,configPath]=process.argv.slice(2);
const {Worker,Log}=await import(pathToFileURL(path.join(candidate,'src/core.mjs')));
const config=JSON.parse((await fs.readFile(configPath,'utf8')).replace(/^\uFEFF/,''));
const workers=[];
try {
 for(const name of ['browser','desktop']) {
  const spec=config.workers.find(w=>w.name===name);
  if(!spec)throw Error('Worker missing: '+name);
  const worker=new Worker(spec,new Log(path.join(config.dataDir,'worker-probe-logs')));
  workers.push(worker);
  const tools=await worker.list();
  if(!Array.isArray(tools)||tools.length===0)throw Error('No tools discovered: '+name);
  console.log(name+': '+tools.length+' upstream tools discovered');
 }
}finally{await Promise.allSettled(workers.map(w=>w.stop()));}
