import {test} from 'node:test';import assert from 'node:assert/strict';
import {startTunnelHTTPS} from '../src/tunnel-https.mjs';
test('TLS ingress refuses exposure on non-loopback interface',()=>{
 assert.throws(()=>startTunnelHTTPS({host:'0.0.0.0',targetPort:1234}),/loopback_only/);
});
