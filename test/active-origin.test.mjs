import test from 'node:test';
import assert from 'node:assert/strict';
import {isActiveHost,isActivePublicHost} from '../src/active-origin.mjs';
const active='https://clientdev.tunnel.homemcp.si';
test('only active public hostname is accepted at both ingress layers',()=>{
 assert.equal(isActiveHost('clientdev.tunnel.homemcp.si',active),true);
 assert.equal(isActivePublicHost('clientdev.tunnel.homemcp.si',active),true);
 assert.equal(isActiveHost('homemcp.shootingsyh.xyz',active),false);
 assert.equal(isActivePublicHost('homemcp.shootingsyh.xyz',active),false);
 assert.equal(isActiveHost('127.0.0.1:8822',active),true);
 assert.equal(isActivePublicHost('127.0.0.1:8443',active),false);
 assert.equal(isActiveHost('clientdev.tunnel.homemcp.si.evil.test',active),false);
 assert.equal(isActiveHost('',active),false);
});
