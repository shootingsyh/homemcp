// HomeMCP tunnel control-plane client. No TLS keys or MCP credentials are sent here.
export class TunnelAPIError extends Error {
  constructor(status,code,message){super(message||code);this.name='TunnelAPIError';this.status=status;this.code=code}
}
export class TunnelClient {
  constructor({base='https://api.homemcp.si',fetchImpl=fetch,token=null}={}){
    if(new URL(base).protocol!=='https:')throw new Error('https_api_required');
    this.base=base.replace(/\/$/,'');this.fetch=fetchImpl;this.token=token;
  }
  async request(method,path,{data,token=this.token}={}){
    const url=new URL(path,this.base);if(url.origin!==new URL(this.base).origin)throw new Error('invalid_api_path');
    const headers={Accept:'application/json'};
    if(data!==undefined)headers['Content-Type']='application/json';
    if(token)headers.Authorization=`Bearer ${token}`;
    const response=await this.fetch(url,{method,headers,body:data===undefined?undefined:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(15000)});
    const body=await response.json().catch(()=>null);
    if(!response.ok)throw new TunnelAPIError(response.status,body?.error?.code||'http_error',body?.error?.message||`HTTP ${response.status}`);
    return body;
  }
  enroll(username,plan){return this.request('POST','/api/v1/enrollments',{data:{username,plan}})}
  // Status reads are safe: only explicit POST may issue credentials.
  getEnrollment(id){return this.request('GET',`/api/v1/enrollments/${encodeURIComponent(id)}`)}
  claimEnrollment(id){return this.request('POST',`/api/v1/enrollments/${encodeURIComponent(id)}/claim`)}
  ackEnrollment(id,token){return this.request('POST',`/api/v1/enrollments/${encodeURIComponent(id)}/claim/ack`,{data:{token}})}
  async claimAndSave(id,save,{existing=null,maxAttempts=8}={}){
    // Recover a crash between durable persistence and ACK without rotating first.
    if(existing?.token){
      try{await this.ackEnrollment(id,existing.token);return existing}
      catch(e){if(!(e instanceof TunnelAPIError)||!'stale_claim,not_claimed'.split(',').includes(e.code))throw e}
    }
    const status=await this.getEnrollment(id);
    if(status.status==='pending_payment')return null;
    if(status.status==='claimed'&&status.claim_acked)throw new Error('claim_already_acked_credentials_unavailable');
    for(let i=0;i<maxAttempts;i++){
      const response=await this.claimEnrollment(id);
      const c=validateClaim(response);
      if(!c)throw new Error('invalid_claim_response');
      await save(c); // MUST durably persist before ACK; failures leave claim recoverable.
      try{await this.ackEnrollment(id,c.token);return c}
      catch(e){if(e instanceof TunnelAPIError&&e.code==='stale_claim')continue;throw e}
    }
    throw new Error('claim_stale_retry_exhausted');
  }
  account(){return this.request('GET','/api/v1/account')}
  portal(){return this.request('POST','/api/v1/account/portal')}
  deleteMockAccount(){return this.request('DELETE','/api/v1/account')}
  createChallenge(value){if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('invalid_dns_digest');return this.request('POST','/api/v1/certificates/dns-challenges',{data:{value}})}
  challenge(id){return this.request('GET',`/api/v1/certificates/dns-challenges/${encodeURIComponent(id)}`)}
  removeChallenge(id){return this.request('DELETE',`/api/v1/certificates/dns-challenges/${encodeURIComponent(id)}`)}
  async waitPropagation(id,{intervalMs=10000,attempts=60,onProgress=()=>{}}={}){
    for(let i=0;i<attempts;i++){
      const result=await this.challenge(id);onProgress(result);
      if(result.status==='propagated')return result;
      if(result.status==='expired'||result.status==='cleaned')throw new Error(`dns_challenge_${result.status}`);
      if(i<attempts-1)await new Promise(resolve=>setTimeout(resolve,intervalMs));
    }
    throw new Error('dns_propagation_timeout');
  }
  async withDNSChallenge(value,validate,{intervalMs=10000}={}){
    const challenge=await this.createChallenge(value);
    try{await this.waitPropagation(challenge.id,{intervalMs});return await validate(challenge)}
    finally{await this.removeChallenge(challenge.id)}
  }
}
export function validateClaim(response){
  if(response?.status!=='claimed'||!response.credentials)return null;
  const c=response.credentials;
  if(!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.tunnel\.homemcp\.si$/.test(c.subdomain)||typeof c.token!=='string'||c.token.length<32||typeof c.frpc_config!=='string'||!c.frpc_config.includes('BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP'))throw new Error('invalid_claim_credentials');
  return c;
}
