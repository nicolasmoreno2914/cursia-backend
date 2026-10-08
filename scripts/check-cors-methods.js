#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.2.1 · CORS del API: todo método HTTP que usa un controller está permitido, PROBADO CON UN CHROME REAL.
//
// Por qué: PUT /courses/:id/brief (8.1) y PUT /courses/:id/academic-context/outcomes (8.2) fallaban en el navegador
// («Failed to fetch»: el preflight no permitía PUT) mientras los E2E pasaban, porque Node no aplica CORS.
//
//   CM1 estático: cada @Get/@Post/@Put/@Patch/@Delete de src/**/*.controller.ts está en CORS_METHODS; las cabeceras del
//       cliente (24-backend-client.js) están en CORS_ALLOWED_HEADERS.
//   CM2 navegador: app Nest mínima con enableCors(corsOptions(...)) — la MISMA función que usa main.ts — en un puerto y
//       una página en OTRO origen: Chrome headless hace fetch GET/POST/PUT/PATCH/DELETE con Authorization + JSON → todos OK.
//   CM3 control negativo: la misma app con la configuración anterior (sin PUT) → el PUT del navegador falla
//       (TypeError: Failed to fetch) y el resto pasa: la prueba reproduce el bug real.
//
// Contra dist/ ("npm run build" antes). Sin red externa (solo 127.0.0.1), USD 0.
// Uso: node scripts/check-cors-methods.js [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); }
}
const C = loadDist('common/cors-options.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.controller\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

async function corsApp(options) {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { Module, Controller, Get, Post, Put, Patch, Delete, Body, Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  class Probe {
    get() { return { ok: true, m: 'GET' }; }
    post(b) { return { ok: true, m: 'POST', b }; }
    put(b) { return { ok: true, m: 'PUT', b }; }
    patch(b) { return { ok: true, m: 'PATCH', b }; }
    del() { return { ok: true, m: 'DELETE' }; }
  }
  const dec = (d, name) => d(Probe.prototype, name, Object.getOwnPropertyDescriptor(Probe.prototype, name));
  dec(Get('probe'), 'get');
  for (const [D, n] of [[Post, 'post'], [Put, 'put'], [Patch, 'patch']]) {
    dec(D('probe'), n);
    Body()(Probe.prototype, n, 0);
  }
  dec(Delete('probe'), 'del');
  Controller()(Probe);
  class ProbeModule {}
  Module({ controllers: [Probe] })(ProbeModule);
  const app = await NestFactory.create(ProbeModule, { logger: false });
  app.enableCors(options);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

function pageServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>origen de prueba</title>'); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const BROWSER_PROBE = (api) => `(async () => {
  const out = {};
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    try {
      const r = await fetch(${JSON.stringify(api)} + '/probe', { method: m, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer prueba' }, ...(m === 'GET' || m === 'DELETE' ? {} : { body: JSON.stringify({ x: 1 }) }) });
      const j = await r.json();
      out[m] = r.status + ':' + j.m;
    } catch (e) { out[m] = 'ERR:' + e.name + ':' + e.message; }
  }
  return out;
})()`;

(async () => {
  await check('CM1 todo método de un controller está permitido por CORS; las cabeceras del cliente también', () => {
    const used = new Map();
    for (const f of walk(path.join(REPO, 'src'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(/g)) {
        const verb = m[1].toUpperCase();
        if (!used.has(verb)) used.set(verb, path.relative(REPO, f));
      }
    }
    assert(used.has('PUT'), 'hay rutas PUT (brief, outcomes): si dejan de existir, revisar esta prueba');
    for (const [verb, where] of used) assert(C.CORS_METHODS.includes(verb), `${verb} (usado en ${where}) no está en CORS_METHODS`);
    eq(C.corsOptions({}).methods, [...C.CORS_METHODS], 'corsOptions usa CORS_METHODS');
    eq(C.corsOptions({ CORS_ORIGIN: 'https://a.test,https://b.test' }).origin, ['https://a.test', 'https://b.test'], 'orígenes desde CORS_ORIGIN');
    const fe = process.env.CURSIA_FRONTEND_REPO ? path.join(process.env.CURSIA_FRONTEND_REPO, 'src/js/24-backend-client.js') : null;
    if (fe && fs.existsSync(fe)) {
      const m = /var headers = \{([^}]*)\}/.exec(fs.readFileSync(fe, 'utf8'));
      assert(m, 'cabeceras de backendApiRequest');
      const sent = [...m[1].matchAll(/'([A-Za-z-]+)'\s*:/g)].map((x) => x[1]);
      for (const h of sent) assert(C.CORS_ALLOWED_HEADERS.map((x) => x.toLowerCase()).includes(h.toLowerCase()), `cabecera «${h}» del cliente no permitida por CORS`);
    } else console.log('   (sin CURSIA_FRONTEND_REPO: no se cruzan las cabeceras del cliente)');
    // QA staging (Prebrief): el nombre del PDF viaja en Content-Disposition; el navegador solo la deja leer si se expone.
    eq(C.corsOptions({}).exposedHeaders, ['Content-Disposition'], 'corsOptions expone Content-Disposition (nombre del PDF)');
    if (fe && fs.existsSync(fe)) assert(/headers\.get\('Content-Disposition'\)|headers\.get\("Content-Disposition"\)|content-disposition/i.test(fs.readFileSync(fe, 'utf8')), 'el cliente lee Content-Disposition');
    const main = fs.readFileSync(path.join(REPO, 'src/main.ts'), 'utf8');
    assert(/app\.enableCors\(corsOptions\(process\.env\)\)/.test(main), 'main.ts usa corsOptions (una sola definición)');
    // Piloto: CORS antes de los parsers del cuerpo (un 413/400 del parser también lleva la cabecera y el navegador lee el mensaje).
    const iCors = main.indexOf('app.enableCors(');
    const iJson = main.indexOf('express.json(');
    assert(iCors > 0 && iJson > 0 && iCors < iJson, 'main.ts: enableCors va ANTES de express.json (si no, un cuerpo demasiado grande llega al navegador como «Failed to fetch»)');
  });

  const { launchChrome } = require(path.join(REPO, 'scripts/lib/v21-cdp.js'));
  const page = await pageServer();
  let chrome = null;
  const apps = [];
  try {
    chrome = await launchChrome();
    await chrome.navigate(page.origin + '/');

    await check('CM2 Chrome real, otro origen: GET/POST/PUT/PATCH/DELETE con Authorization pasan con corsOptions (la de main.ts)', async () => {
      const a = await corsApp(C.corsOptions({ CORS_ORIGIN: page.origin }));
      apps.push(a.app);
      const r = await chrome.evaluate(BROWSER_PROBE(a.url));
      eq(r, { GET: '200:GET', POST: '201:POST', PUT: '200:PUT', PATCH: '200:PATCH', DELETE: '200:DELETE' }, 'respuestas en el navegador');
    });

    await check('CM3 control negativo: con la configuración anterior (sin PUT) el PUT del navegador falla y el resto pasa', async () => {
      const legacy = { ...C.corsOptions({ CORS_ORIGIN: page.origin }), methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] };
      const a = await corsApp(legacy);
      apps.push(a.app);
      const r = await chrome.evaluate(BROWSER_PROBE(a.url));
      assert(/^ERR:TypeError/.test(r.PUT), `PUT debía fallar por CORS: ${r.PUT}`);
      eq([r.GET, r.POST, r.PATCH, r.DELETE], ['200:GET', '201:POST', '200:PATCH', '200:DELETE'], 'los demás métodos');
    });
  } finally {
    for (const a of apps) await a.close().catch(() => {});
    page.srv.close();
    if (chrome) chrome.close();
  }
  console.log(`\n${passed} OK, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
