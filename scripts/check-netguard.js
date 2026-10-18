#!/usr/bin/env node
/* eslint-disable */
// r58 (I1) — BARRERA DE RED (scripts/lib/netguard.js): la usan el driver offline de componentes y el replay; el preload
// del gate/E2E (test/e2e-v2/netguard.js) es la misma implementación (installSocketGuard). Sin red real: los destinos
// son de documentación (203.0.113.0/24, TEST-NET-3) o loopback local; nada sale de la máquina.
//
//   NG1 barrera: fetch / http(s).request / http(s).get / tls.connect / http2.connect lanzan NETWORK_BLOCKED y quedan
//       registrados; un socket TCP (también a loopback) se corta con error y queda registrado
//   NG2 assertClean falla si hubo un intento; uninstall restaura fetch / https.request / net.Socket.connect
//   NG3 el driver offline corre CON la barrera activa (el proveedor la ve encendida) y un componente que intenta red
//       hace FALLAR la corrida (NETWORK_BLOCKED en errors, attempts > 0); sin intentos, attempts = 0
//   NG4 preload del gate (test/e2e-v2/netguard.js, proceso hijo): externo bloqueado + renglón «BLOCKED <host>» en
//       $E2E_NET_LOG; loopback permitido (servidor local responde)
//
// Uso: node scripts/check-netguard.js   (NG3 requiere `npm run build`)
'use strict';
require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const NG = require('./lib/netguard');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n   ')}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const throwsBlocked = async (fn, what) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert(err && err.code === NG.NETWORK_BLOCKED, `${what}: debía lanzar NETWORK_BLOCKED (vino ${err ? err.message : 'sin error'})`);
};
const socketBlocked = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); resolve({ blocked: false, why: 'timeout' }); }, 3000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve({ blocked: false, why: 'connected' }); });
  s.on('error', (e) => { clearTimeout(t); resolve({ blocked: /bloqueada/.test(e.message), why: e.message }); });
});

(async () => {
  await check('NG1 barrera: fetch, http(s).request/get, tls/http2.connect y sockets (incluso loopback) bloqueados y registrados', async () => {
    const origFetch = globalThis.fetch;
    const b = NG.installNetworkBarrier({ label: 'check' });
    try {
      assert(NG.networkBarrierActive(), 'la barrera debía quedar activa');
      await throwsBlocked(() => fetch('https://api.anthropic.com/v1/messages'), 'fetch');
      await throwsBlocked(() => require('https').request('https://public-api.gamma.app/v0.2/generations'), 'https.request');
      await throwsBlocked(() => require('https').get({ host: 'api.openai.com', path: '/' }), 'https.get');
      await throwsBlocked(() => require('http').request({ hostname: '203.0.113.7', port: 80 }), 'http.request');
      await throwsBlocked(() => require('http').get('http://203.0.113.7/'), 'http.get');
      await throwsBlocked(() => require('tls').connect({ host: 'www.googleapis.com', port: 443 }), 'tls.connect');
      await throwsBlocked(() => require('http2').connect('https://www.googleapis.com'), 'http2.connect');
      const ext = await socketBlocked('203.0.113.9', 443);
      assert(ext.blocked, `socket externo no bloqueado (${ext.why})`);
      const lo = await socketBlocked('127.0.0.1', 9);
      assert(lo.blocked, `socket a loopback no bloqueado por la barrera del driver (${lo.why})`);
      const vias = b.attempts.map((a) => a.via);
      for (const v of ['fetch', 'https.request', 'https.get', 'http.request', 'http.get', 'tls.connect', 'http2.connect', 'socket']) assert(vias.includes(v), `intento ${v} no registrado (${vias.join(',')})`);
      assert(b.attempts.some((a) => a.target.includes('203.0.113.9')) && b.attempts.some((a) => a.target === '127.0.0.1'), 'destinos de socket no registrados');
    } finally { b.uninstall(); }
    assert(globalThis.fetch === origFetch, 'uninstall no restauró fetch');
  });

  await check('NG2 assertClean falla con intentos y pasa sin ellos; uninstall restaura https.request y net.Socket.connect', async () => {
    const origReq = require('https').request;
    const origConnect = net.Socket.prototype.connect;
    const b = NG.installNetworkBarrier();
    let ok = true;
    try { b.assertClean(); } catch (e) { ok = false; }
    assert(ok, 'assertClean falló sin intentos');
    await fetch('https://example.invalid/').catch(() => null);
    let err = null;
    try { b.assertClean(); } catch (e) { err = e; }
    assert(err && err.code === NG.NETWORK_BLOCKED, 'assertClean debía fallar tras un intento');
    b.uninstall();
    assert(require('https').request === origReq && net.Socket.prototype.connect === origConnect && !NG.networkBarrierActive(), 'uninstall no restauró los originales');
  });

  await check('NG3 el driver offline corre con la barrera activa; un componente que intenta red hace fallar la corrida', async () => {
    const D = require('./lib/offline-driver');
    const R = require('./lib/replay-api');
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/offline-driver/course.json'), 'utf8'));
    const DIST = path.join(ROOT, 'dist');
    // Proveedor falso que verifica la barrera en cada llamada y, en la variante «leaky», intenta salir a la red.
    const mk = (leaky) => {
      let fake = null;
      let seenActive = true;
      return {
        provider: {
          name: leaky ? 'leaky-fake' : 'checked-fake', real: false,
          respond(body) {
            if (!NG.networkBarrierActive()) seenActive = false;
            if (leaky) { try { require('https').request('https://api.anthropic.com/v1/messages'); } catch (e) { return { httpStatus: 400, error: e.message }; } }
            return fake.respond(body);
          },
        },
        bind(f) { fake = f; },
        seen: () => seenActive,
      };
    };
    for (const leaky of [false, true]) {
      const p = mk(leaky);
      // El falso del E2E necesita los títulos → ids del curso: se arma con la estructura del mismo curso.
      const prep = await require('./lib/commercial-simulation').prepareCourse(DIST, { ...cfg, title: D.SYNTHETIC_TITLE_PREFIX + cfg.title });
      const outlineOf = prep.structure.modules.map((m) => ({ id: m.id, title: m.title, chapters: m.chapters.map((c) => ({ id: c.id, title: c.title })) }));
      p.bind(R.createFakeProvider(DIST, outlineOf, { courseId: cfg.courseId }));
      const r = await D.runComponents(DIST, cfg, { select: [{ type: 'content', chapter: { m: 0, c: 0 } }], llm: { mode: 'fake', provider: p.provider } });
      assert(p.seen(), 'el proveedor corrió sin la barrera activa');
      assert(!NG.networkBarrierActive(), 'la barrera quedó instalada después de la corrida');
      if (!leaky) {
        assert(r.ok && r.network.attempts.length === 0, `corrida limpia con intentos/errores: ${JSON.stringify(r.errors.slice(0, 2))}`);
      } else {
        assert(!r.ok, 'la corrida con un intento de red debía fallar');
        assert(r.network.attempts.length > 0 && r.errors.some((e) => e.code === NG.NETWORK_BLOCKED), `sin NETWORK_BLOCKED en errors: ${JSON.stringify(r.errors.slice(0, 3))}`);
      }
    }
  });

  await check('NG4 preload del gate (test/e2e-v2/netguard.js): externo bloqueado y registrado en $E2E_NET_LOG; loopback permitido', async () => {
    const log = path.join(os.tmpdir(), `check-netguard-${process.pid}.log`);
    try { fs.unlinkSync(log); } catch (e) { /* no existe */ }
    const child = `
      const net = require('net');
      const srv = net.createServer((s) => { s.end('ok'); });
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        const lo = net.connect({ host: '127.0.0.1', port });
        lo.on('data', () => {
          lo.destroy();
          const ex = net.connect({ host: '203.0.113.5', port: 443 });
          ex.on('error', (e) => { console.log(JSON.stringify({ loopback: true, external: e.message })); srv.close(); });
          ex.on('connect', () => { console.log(JSON.stringify({ loopback: true, external: 'CONNECTED' })); process.exit(3); });
        });
        lo.on('error', (e) => { console.log(JSON.stringify({ loopback: false, err: e.message })); process.exit(4); });
      });`;
    const r = spawnSync(process.execPath, ['--require', path.join(ROOT, 'test/e2e-v2/netguard.js'), '-e', child], { env: { PATH: process.env.PATH, E2E_NET_LOG: log }, encoding: 'utf8', timeout: 20000 });
    const out = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
    assert(r.status === 0 && out.loopback === true, `loopback no permitido: ${r.stdout} ${r.stderr}`);
    assert(/E2E netguard: conexión externa bloqueada a 203\.0\.113\.5/.test(out.external || ''), `externo no bloqueado: ${out.external}`);
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    assert(lines.length === 1 && / BLOCKED 203\.0\.113\.5$/.test(lines[0]) && /proc=\S+/.test(lines[0]), `renglón del log inesperado: ${JSON.stringify(lines)}`);
    try { fs.unlinkSync(log); } catch (e) { /* ya no existe */ }
  });

  console.log(`\n${passed} ok, ${failed} fallos`);
  process.exit(failed ? 1 : 0);
})();
