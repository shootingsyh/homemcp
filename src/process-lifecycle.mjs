import {spawn} from 'node:child_process';

// Cross-platform child-process API. Windows job membership is inherited from
// the Manager-supervised Host, not implemented or queried by MCP business logic.
export function launchWorker(spec,options){
 return spawn(spec.command,spec.args||[],options);
}
export async function stopWorker(child,{platform=process.platform,launch=spawn}={}){
 if(!child)return;
 if(platform==='win32'){
  await new Promise(resolve=>{
   const killer=launch('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
   killer.once('error',resolve);
   killer.once('exit',resolve);
  });
 }else{try{child.kill('SIGTERM')}catch{}}
}
