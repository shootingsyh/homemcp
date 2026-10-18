#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
SCRATCH=$(mktemp -d)
HOSTPID=''
cleanup(){
 if [ -n "$HOSTPID" ]; then kill "$HOSTPID" 2>/dev/null || true; wait "$HOSTPID" 2>/dev/null || true; fi
 rm -rf "$SCRATCH"
}
trap cleanup EXIT INT TERM
export HOMEMCP_HOME="$SCRATCH/user-config"
node "$ROOT/scripts/macos/provision.mjs"
node "$ROOT/src/server.mjs" --config "$HOMEMCP_HOME/config.json" > "$SCRATCH/server.out" 2> "$SCRATCH/server.err" &
HOSTPID=$!
node --input-type=module - "$HOMEMCP_HOME/config.json" <<'JS'
import fs from 'node:fs';
import process from 'node:process';
const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for(let attempt=0;attempt<30;attempt++){
 try{
  const r=await fetch('http://127.0.0.1:'+c.port+'/health',{signal:AbortSignal.timeout(1500)});
  const result=await r.json();
  if(r.ok&&result.ok===true){console.log('MACOS_HOST_HEALTH_OK');process.exit(0)}
 }catch{}
 await new Promise(resolve=>setTimeout(resolve,250));
}
console.error('MACOS_HOST_HEALTH_FAILED');
process.exit(1);
JS
