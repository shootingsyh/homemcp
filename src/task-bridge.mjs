/**
 * MCP 2025-11-25 experimental task adapter.
 * Task IDs refer only to explicitly task-augmented approval requests.
 * Existing non-task clients retain their original CallToolResult contract.
 */
export const taskProtocol='2025-11-25';
export const taskCapabilities={tasks:{requests:{tools:{call:{}}}}};
export function taskSnapshot(store,id){
 const link=store.taskLink(id);
 if(!link)return null;
 const item=store.result(link.approval_id);
 if(!item)return null;
 const statuses={pending:'working',approved:'working',executing:'working',completed:'completed',rejected:'cancelled',expired:'failed',failed:'failed',outcome_unknown:'failed',interrupted:'failed'};
 const status=statuses[item.status]||'failed';
 return {taskId:id,status,statusMessage:item.status==='pending'?'Passkey approval required':item.status,createdAt:new Date(link.created_at).toISOString(),lastUpdatedAt:new Date(link.updated_at).toISOString(),ttl:link.ttl,pollInterval:2000};
}
export const isTerminal=x=>['completed','failed','cancelled'].includes(x);
export function taskFinal(store,id,toToolResult){
 const task=taskSnapshot(store,id);if(!task||!isTerminal(task.status))return null;
 const record=store.result(id);
 return {...toToolResult(record),_meta:{'io.modelcontextprotocol/related-task':{taskId:id}}};
}
