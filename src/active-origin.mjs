// One active public origin per HomeMCP installation. Local loopback access is private and unaffected.
export function isActiveHost(requestHost,activeOrigin){
 if(!activeOrigin)return true;
 if(typeof requestHost!=='string'||!requestHost)return false;
 if(requestHost.includes('@')||requestHost.includes('/')||requestHost.includes('\\'))return false;
 let hostname;
 try{hostname=new URL('http://'+requestHost).hostname.toLowerCase();}catch{return false;}
 if(['127.0.0.1','::1','localhost'].includes(hostname))return true;
 try{return hostname===new URL(activeOrigin).hostname.toLowerCase();}catch{return false;}
}
export function isActivePublicHost(requestHost,activeOrigin){
 if(!activeOrigin)return false;
 if(requestHost.includes('@')||requestHost.includes('/')||requestHost.includes('\\'))return false;
 let hostname;
 try{hostname=new URL('http://'+requestHost).hostname.toLowerCase();}catch{return false;}
 try{return hostname===new URL(activeOrigin).hostname.toLowerCase();}catch{return false;}
}
