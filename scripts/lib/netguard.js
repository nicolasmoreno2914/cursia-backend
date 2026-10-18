/* eslint-disable */
// r58 (I1) — BARRERA DE RED como librería. Una sola implementación para:
//   - el preload del gate/E2E (test/e2e-v2/netguard.js: `installSocketGuard({ allowLoopback: true, logFile })`, mismo
//     comportamiento de siempre: conexión TCP/TLS fuera de loopback → bloqueada + renglón en $E2E_NET_LOG);
//   - el driver offline de componentes y el replay (scripts/lib/offline-driver.js, scripts/lib/replay-api.js):
//     `installNetworkBarrier()` bloquea TODO (también loopback por defecto): sockets, fetch, http(s).request/get,
//     tls.connect y http2.connect. Cada intento queda registrado y `assertClean()` falla si hubo alguno.
// No es código de producto: instrumentación de pruebas. Sin dependencias.
'use strict';
const net = require('net');
const fs = require('fs');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const NETWORK_BLOCKED = 'NETWORK_BLOCKED';

/** Host de los argumentos de net.Socket.prototype.connect (null = socket unix: nunca es red). */
function connectHost(args) {
  const a0 = args[0];
  if (Array.isArray(a0)) return (a0[0] && a0[0].host) || 'localhost';
  if (a0 && typeof a0 === 'object') return a0.path ? null : (a0.host || 'localhost');
  if (typeof a0 === 'string' && isNaN(Number(a0))) return null;
  return (typeof args[1] === 'string' ? args[1] : undefined) || 'localhost';
}

function procLabel() {
  return (process.argv[1] || 'node').split('/').slice(-2).join('/');
}

/**
 * Guarda de sockets (el preload de siempre). Devuelve una función para desinstalarla.
 * @param {{ allowLoopback?: boolean, logFile?: string|null, onBlocked?: (host: string) => void }} o
 */
function installSocketGuard(o = {}) {
  const allowLoopback = o.allowLoopback !== false;
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const host = connectHost(args);
    if (host === null || (allowLoopback && LOOPBACK.has(host))) return orig.apply(this, args);
    // R13: etiqueta del proceso (script) para atribuir el intento por proveedor en el resumen.
    const line = `${new Date().toISOString()} pid=${process.pid} proc=${procLabel()} BLOCKED ${host}\n`;
    try { if (o.logFile) fs.appendFileSync(o.logFile, line); } catch (e) { /* ignore */ }
    try { if (o.onBlocked) o.onBlocked(host); } catch (e) { /* ignore */ }
    const err = new Error(`E2E netguard: conexión externa bloqueada a ${host}`);
    process.nextTick(() => this.destroy(err));
    return this;
  };
  return () => { net.Socket.prototype.connect = orig; };
}

let active = null;

/**
 * Barrera completa para el driver offline / replay. Idempotente por proceso (una segunda llamada devuelve la misma).
 * @param {{ allowLoopback?: boolean, label?: string }} o
 * @returns {{ attempts: Array<{via:string,target:string}>, assertClean(): void, uninstall(): void, active: boolean }}
 */
function installNetworkBarrier(o = {}) {
  if (active) return active;
  const attempts = [];
  const allowLoopback = o.allowLoopback === true;
  const record = (via, target) => { attempts.push({ via, target: String(target).slice(0, 200) }); };
  const blocked = (via, target) => {
    record(via, target);
    const e = new Error(`${NETWORK_BLOCKED}: ${via} → ${String(target).slice(0, 120)} (driver offline: sin red)`);
    e.code = NETWORK_BLOCKED;
    return e;
  };
  const restore = [];
  restore.push(installSocketGuard({ allowLoopback, onBlocked: (h) => record('socket', h) }));
  const g = globalThis;
  const origFetch = g.fetch;
  g.fetch = async (u) => { throw blocked('fetch', u && u.url ? u.url : u); };
  restore.push(() => { g.fetch = origFetch; });
  const patch = (mod, name, via) => {
    const m = require(mod);
    const orig = m[name];
    m[name] = function (a0) {
      const target = typeof a0 === 'string' ? a0 : a0 && (a0.href || a0.host || a0.hostname) ? (a0.href || `${a0.host || a0.hostname}`) : '?';
      throw blocked(via, target);
    };
    restore.push(() => { m[name] = orig; });
  };
  patch('http', 'request', 'http.request');
  patch('http', 'get', 'http.get');
  patch('https', 'request', 'https.request');
  patch('https', 'get', 'https.get');
  patch('tls', 'connect', 'tls.connect');
  patch('http2', 'connect', 'http2.connect');
  g.__CURSIA_NETWORK_BARRIER__ = true;
  active = {
    active: true,
    attempts,
    label: o.label || 'offline',
    assertClean() {
      if (attempts.length) {
        const e = new Error(`${NETWORK_BLOCKED}: ${attempts.length} intento(s) de red durante una corrida offline: ${attempts.slice(0, 5).map((a) => `${a.via}→${a.target}`).join(', ')}`);
        e.code = NETWORK_BLOCKED;
        throw e;
      }
    },
    uninstall() {
      while (restore.length) restore.pop()();
      delete g.__CURSIA_NETWORK_BARRIER__;
      active.active = false;
      active = null;
    },
  };
  return active;
}

function networkBarrierActive() {
  return !!(active && active.active);
}

module.exports = { installSocketGuard, installNetworkBarrier, networkBarrierActive, connectHost, LOOPBACK, NETWORK_BLOCKED };
