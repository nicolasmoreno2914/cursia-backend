// Preload (NODE_OPTIONS=--require) para el app Nest y los workers del E2E:
// cualquier conexión TCP/TLS a algo que no sea loopback se BLOQUEA y se
// registra en $E2E_NET_LOG. No es código de producto: solo instrumentación.
'use strict';
const net = require('net');
const fs = require('fs');
const LOG = process.env.E2E_NET_LOG;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const orig = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let host;
  const a0 = args[0];
  if (Array.isArray(a0)) {
    host = a0[0] && a0[0].host;
  } else if (a0 && typeof a0 === 'object') {
    if (a0.path) return orig.apply(this, args); // unix socket
    host = a0.host;
  } else if (typeof a0 === 'string' && isNaN(Number(a0))) {
    return orig.apply(this, args); // unix socket path
  } else {
    host = typeof args[1] === 'string' ? args[1] : undefined;
  }
  host = host || 'localhost';
  if (!LOOPBACK.has(host)) {
    const line = `${new Date().toISOString()} pid=${process.pid} BLOCKED ${host}\n`;
    try { if (LOG) fs.appendFileSync(LOG, line); } catch (e) { /* ignore */ }
    const err = new Error(`E2E netguard: conexión externa bloqueada a ${host}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return orig.apply(this, args);
};
