import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export const EGRESS_MODES = ["disabled", "external", "cloudflare"];
export function renderCloudflareConfig({tunnel,credentialsFile,hostname,originPort}) {
 if (!tunnel || !credentialsFile || !hostname || !Number.isInteger(originPort)) throw new Error("invalid_cloudflare_config");
 return JSON.stringify({tunnel,"credentials-file":credentialsFile,ingress:[{hostname,service:"http://127.0.0.1:"+originPort},{service:"http_status:404"}]},null,2)+"\n";
}
export class EgressManager {
 constructor(config,log,configDir){this.config=config||{mode:"disabled"};this.log=log;this.configDir=configDir;this.child=null;}
 get mode(){return this.config.mode||"disabled";}
 get state(){return {mode:this.mode,managed:this.mode==="cloudflare",running:!!this.child&&this.child.exitCode===null,childPid:this.child?.pid||null};}
 async start(port){
  if(!EGRESS_MODES.includes(this.mode))throw new Error("unsupported_egress_mode");
  if(this.mode!=="cloudflare"||!this.config.enabled)return;
  if(this.child&&this.child.exitCode===null)return;
  if(!this.config.accessVerified)throw new Error("cloudflare_access_not_confirmed");
  const folder=path.join(this.configDir,"egress");fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,"cloudflared.json");fs.writeFileSync(file,renderCloudflareConfig({...this.config,originPort:port}));
  const child=spawn(this.config.executable||"cloudflared.exe",["tunnel","--config",file,"run",this.config.tunnel],{windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});
  this.child=child;child.stdout.on("data",d=>this.log.write("debug","egress_stdout",{bytes:d.length}));child.stderr.on("data",d=>this.log.write("debug","egress_stderr",{bytes:d.length}));
  child.on("error",e=>this.log.write("error","egress_error",{message:e.message}));child.on("exit",(code,signal)=>{this.log.write("warn","egress_exit",{code,signal});if(this.child===child)this.child=null;});
 }
 async stop(){const child=this.child;this.child=null;if(!child)return;if(process.platform==="win32"){await new Promise(resolve=>{const p=spawn("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});p.once("error",resolve);p.once("exit",resolve);});}else child.kill("SIGTERM");}
}