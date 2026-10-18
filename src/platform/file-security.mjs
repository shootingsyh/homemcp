import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function validateDeletionPath(raw,{platform=process.platform,home=os.homedir()}={}){
 if(typeof raw!=='string'||!raw||raw.includes('\0'))throw new Error('invalid_file_delete_arguments');
 const p=platform==='win32'?path.win32:path.posix;
 if(!p.isAbsolute(raw))throw new Error('invalid_absolute_file_path');
 if(platform==='win32'&&(raw.startsWith('\\\\')||raw.includes('/')||raw.endsWith('\\')))throw new Error('invalid_absolute_windows_path');
 const full=p.normalize(raw);
 const homePath=p.normalize(home);
 const within=(dir,file)=>{
  const relative=p.relative(dir,file);
  return !!relative&&relative!=='..'&&!relative.startsWith('..'+p.sep)&&!p.isAbsolute(relative);
 };
 if(!within(homePath,full))throw new Error('file_outside_user_home');
 const stat=fs.lstatSync(full);
 if(!stat.isFile()||stat.isSymbolicLink())throw new Error('not_regular_file');
 const canonicalHome=fs.realpathSync.native(homePath);
 const canonicalFile=fs.realpathSync.native(full);
 if(!within(canonicalHome,canonicalFile))throw new Error('file_outside_user_home');
 return full;
}
