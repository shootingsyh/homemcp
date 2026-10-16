import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {tokenEqual} from './core.mjs';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validId=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
export function policyFor(name,policy={}){const value=policy[name]??'deny';if(!['allow','ask','deny'].includes(value))throw new Error('invalid_policy_'+name);return value;}
export class ApprovalStore{
 constructor(dataDir,{timeoutMs=120000,limit=32}={}){
 fs.mkdirSync(dataDir,{recursive:true});this.db=new DatabaseSync(path.join(dataDir,'approvals.sqlite'));
 this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, tool TEXT NOT NULL, args_sha TEXT NOT NULL, status TEXT NOT NULL, preview TEXT, decision_at INTEGER); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, event TEXT NOT NULL, tool TEXT, approval_id TEXT, outcome TEXT);");
 if(!this.db.prepare('PRAGMA table_info(approvals)').all().some(x=>x.name==='preview'))this.db.exec('ALTER TABLE approvals ADD COLUMN preview TEXT');
 this.db.prepare("UPDATE approvals SET status='interrupted' WHERE status='pending' OR status='approved'").run();this.waiters=new Map();this.timeoutMs=timeoutMs;this.limit=limit;
 }
 record(event,tool=null,id=null,outcome=null){this.db.prepare('INSERT INTO audit(time,event,tool,approval_id,outcome) VALUES(?,?,?,?,?)').run(Date.now(),event,tool,id,outcome);}
 create(tool,args,preview){if(this.waiters.size>=this.limit)throw new Error('approval_queue_full');if(typeof preview!=='string'||!preview)throw new Error('approval_missing_safe_preview');const id=crypto.randomUUID(),now=Date.now(),expires=now+this.timeoutMs;this.db.prepare('INSERT INTO approvals(id,created_at,expires_at,tool,args_sha,status,preview) VALUES(?,?,?,?,?,?,?)').run(id,now,expires,tool,hash({tool,args}),'pending',preview);this.record('approval_requested',tool,id);let timer;const promise=new Promise(resolve=>{timer=setTimeout(()=>{this.complete(id,'expired');resolve('expired');},this.timeoutMs);this.waiters.set(id,{resolve,timer});});return {id,promise,expires};}
 complete(id,decision){if(!validId(id)||!['approved','rejected','expired'].includes(decision))return false;const now=Date.now();const row=this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);if(!row||row.status!=='pending')return false;const actual=now>=row.expires_at?'expired':decision;const changed=this.db.prepare("UPDATE approvals SET status=?,decision_at=? WHERE id=? AND status='pending'").run(actual,now,id).changes;if(!changed)return false;this.record('approval_decided',row.tool,id,actual);const w=this.waiters.get(id);if(w){clearTimeout(w.timer);this.waiters.delete(id);w.resolve(actual);}return actual;}
 pending(){return this.db.prepare("SELECT id,created_at,expires_at,tool,status,preview FROM approvals WHERE status='pending' AND expires_at>? ORDER BY created_at LIMIT 100").all(Date.now());}
 get(id){if(!validId(id))return null;return this.db.prepare('SELECT id,created_at,expires_at,tool,status,preview FROM approvals WHERE id=?').get(id)||null;}
 shutdown(){for(const [id,w] of this.waiters){clearTimeout(w.timer);w.resolve('interrupted');this.db.prepare("UPDATE approvals SET status='interrupted' WHERE id=? AND status='pending'").run(id);}this.waiters.clear();this.db.close();}
}
export function adminAuthorized(header,token){return !!token&&tokenEqual((header||'').match(/^Bearer (.+)$/i)?.[1],token);}
