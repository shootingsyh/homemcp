import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {tokenEqual} from './core.mjs';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validId=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
export function policyFor(name,policy={}){const value=policy[name]??'deny';if(!['allow','ask','deny'].includes(value))throw new Error('invalid_policy_'+name);return value;}
export class ApprovalStore{
 constructor(dataDir,{timeoutMs=600000,limit=32}={}){
  fs.mkdirSync(dataDir,{recursive:true});this.db=new DatabaseSync(path.join(dataDir,'approvals.sqlite'));
  this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, tool TEXT NOT NULL, args_sha TEXT NOT NULL, status TEXT NOT NULL, preview TEXT, decision_at INTEGER); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, event TEXT NOT NULL, tool TEXT, approval_id TEXT, outcome TEXT)");
  for(const [column,type] of [['preview','TEXT'],['args_json','TEXT'],['result_json','TEXT'],['error','TEXT'],['idempotency_key','TEXT']]){
   if(!this.db.prepare('PRAGMA table_info(approvals)').all().some(x=>x.name===column))this.db.exec('ALTER TABLE approvals ADD COLUMN '+column+' '+type);
  }
  this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS approval_idempotency ON approvals(idempotency_key) WHERE idempotency_key IS NOT NULL');
  this.db.prepare("UPDATE approvals SET status='outcome_unknown' WHERE status='executing'").run();
  this.db.prepare("UPDATE approvals SET status='interrupted' WHERE status='pending' AND args_json IS NULL").run();
  this.timeoutMs=timeoutMs;this.limit=limit;
 }
 record(event,tool=null,id=null,outcome=null){this.db.prepare('INSERT INTO audit(time,event,tool,approval_id,outcome) VALUES(?,?,?,?,?)').run(Date.now(),event,tool,id,outcome)}
 create(tool,args,preview,idempotencyKey=null){
  if(typeof preview!=='string'||!preview||preview.length>4096)throw new Error('approval_missing_safe_preview');
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('invalid_arguments');
  if(idempotencyKey!==null&&(typeof idempotencyKey!=='string'||idempotencyKey.length>128||idempotencyKey.length<12))throw new Error('invalid_idempotency_key');
  const digest=hash({tool,args});
  if(idempotencyKey){const existing=this.db.prepare('SELECT * FROM approvals WHERE idempotency_key=?').get(idempotencyKey);if(existing){if(existing.tool!==tool||existing.args_sha!==digest)throw new Error('idempotency_key_conflict');return this.public(existing)}}
  this.db.prepare("UPDATE approvals SET status='expired',decision_at=? WHERE status='pending' AND expires_at<=?").run(Date.now(),Date.now());
  const count=this.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status IN ('pending','approved','executing')").get().n;
  if(count>=this.limit)throw new Error('approval_queue_full');
  const id=crypto.randomUUID(),now=Date.now(),expires=now+this.timeoutMs;
  this.db.prepare('INSERT INTO approvals(id,created_at,expires_at,tool,args_sha,status,preview,args_json,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?)').run(id,now,expires,tool,digest,'pending',preview,JSON.stringify(args),idempotencyKey);
  this.record('approval_requested',tool,id);return this.public(this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id));
 }
 public(row){if(!row)return null;return {id:row.id,pending_id:row.id,created_at:row.created_at,expires_at:row.expires_at,tool:row.tool,arguments_hash:row.args_sha,status:this.state(row),preview:row.preview,error:row.error||undefined}}
 state(row){if(row.status==='pending'&&Date.now()>=row.expires_at)return 'expired';return row.status}
 complete(id,decision){
  if(!validId(id)||!['approved','rejected','expired'].includes(decision))return false;
  const row=this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
  if(!row||this.state(row)!=='pending')return false;
  const actual=Date.now()>=row.expires_at?'expired':decision;
  const changed=this.db.prepare("UPDATE approvals SET status=?,decision_at=? WHERE id=? AND status='pending'").run(actual,Date.now(),id).changes;
  if(!changed)return false;this.record('approval_decided',row.tool,id,actual);return actual;
 }
 cancel(id){return this.complete(id,'rejected')}
 pending(){return this.db.prepare("SELECT * FROM approvals WHERE status='pending' AND expires_at>? ORDER BY created_at LIMIT 100").all(Date.now()).map(x=>this.public(x))}
 get(id){if(!validId(id))return null;return this.public(this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id))}
 claim(id,digest){
  if(!validId(id)||typeof digest!=='string')return null;
  const row=this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
  if(!row||row.args_sha!==digest||row.status!=='approved'||!row.args_json)return null;
  if(!this.db.prepare("UPDATE approvals SET status='executing' WHERE id=? AND status='approved'").run(id).changes)return null;
  this.record('execution_claimed',row.tool,id);
  return {tool:row.tool,args:JSON.parse(row.args_json)};
 }
 finish(id,result,error){
  if(!validId(id))return false;
  const status=error?'failed':'completed';
  const updated=this.db.prepare("UPDATE approvals SET status=?,result_json=?,error=? WHERE id=? AND status='executing'").run(status,error?null:JSON.stringify(result),error?String(error).slice(0,2000):null,id).changes;
  if(updated)this.record('execution_finished',null,id,status);return !!updated;
 }
 result(id){
  if(!validId(id))return null;const row=this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
  if(!row)return null;return {...this.public(row),result:row.status==='completed'?JSON.parse(row.result_json):undefined};
 }
 shutdown(){this.db.close()}
}
export function adminAuthorized(header,token){return !!token&&tokenEqual((header||'').match(/^Bearer (.+)$/i)?.[1],token)}
