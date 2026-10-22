import {isActivePublicHost} from './active-origin.mjs';
// Local HTTPS gateway for FRP SNI passthrough. This service only binds to loopback.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
export function startTunnelHTTPS({keyFile,certFile,key,cert,targetPort,port=8443,host='127.0.0.1',activeOrigin}={}){
  if(!net.isIP(host)||!['127.0.0.1','::1'].includes(host))throw new Error('loopback_only');
  if(!Number.isInteger(targetPort)||targetPort<1||targetPort>65535)throw new Error('invalid_target_port');
  const server=https.createServer({key:key??fs.readFileSync(keyFile),cert:cert??fs.readFileSync(certFile)},(req,res)=>{
    if(!isActivePublicHost(req.headers.host,activeOrigin)){res.writeHead(421,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'inactive_domain'}));return;}
    const proxy=http.request({hostname:'127.0.0.1',port:targetPort,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${targetPort}`}},upstream=>{
      res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);
    });
    proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('HomeMCP backend unavailable')});req.pipe(proxy);
  });
  server.listen(port,host);
  return server;
}
