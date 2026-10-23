#!/usr/bin/env node
/* eslint-disable */
// Loop 4: el cliente de streaming del worker de IA CLASIFICA cada fallo (de eso depende si reintentar es seguro).
// Anthropic falso en 127.0.0.1 (USD 0). Usage: npm run build && node scripts/check-llm-worker-stream.js [dist]
const http = require('http');
const net = require('net');
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const { streamMessage, LlmStreamError } = require(path.join(distRoot, 'workers/llm-executor/anthropic-stream.js'));

let passes = 0; let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sse = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
const start = { message: { id: 'msg_1', model: 'm', usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 7 } } };

function server(handler) {
  return new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((x) => { s.closeAllConnections && s.closeAllConnections(); s.close(() => x()); }) })); });
}
const call = (url, o = {}) => streamMessage({ apiKey: 'k', baseUrl: url, body: { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] }, idleMs: o.idleMs || 2000, totalMs: o.totalMs || 10000 });
async function kindOf(p) { try { await p; return 'ok'; } catch (e) { assert(e instanceof LlmStreamError, 'error tipado: ' + e); return e; } }

(async () => {
  await check('éxito: texto armado, usage final (caché incluida), stop_reason, id, request-id; el body va con stream:true', async () => {
    let got = null;
    const s = await server(async (req, res) => {
      let b = ''; for await (const c of req) b += c; got = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_9' });
      res.write(sse('message_start', start)); res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hola ' } }));
      res.write(sse('ping', {})); res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'mundo' } }));
      res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } })); res.end(sse('message_stop', {}));
    });
    const r = await call(s.url); await s.close();
    assert(got.stream === true, 'stream:true');
    assert(r.text === 'Hola mundo' && r.messageId === 'msg_1' && r.requestId === 'req_9' && r.stopReason === 'end_turn', JSON.stringify(r));
    assert(r.usage.input_tokens === 100 && r.usage.output_tokens === 42 && r.usage.cache_read_input_tokens === 7, JSON.stringify(r.usage));
  });
  await check('never_sent: puerto cerrado (ECONNREFUSED) → el pedido NO salió (reintento seguro, sin costo)', async () => {
    const p = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => r(port)); }); });
    const e = await kindOf(call(`http://127.0.0.1:${p}`));
    assert(e.kind === 'never_sent', e.kind + ' ' + e.message);
  });
  await check('http: error del proveedor con status y cuerpo (resultado conocido)', async () => {
    const s = await server((req, res) => { res.writeHead(529, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"overloaded_error"}}'); });
    const e = await kindOf(call(s.url)); await s.close();
    assert(e.kind === 'http' && e.extra.status === 529 && /overloaded/.test(e.extra.body), JSON.stringify(e.extra));
  });
  await check('unknown: el servidor recibe el pedido y corta la conexión sin responder', async () => {
    const s = await server((req) => { req.on('data', () => {}); req.on('end', () => req.socket.destroy()); });
    const e = await kindOf(call(s.url)); await s.close();
    assert(e.kind === 'unknown', e.kind + ' ' + e.message);
  });
  await check('unknown: headers 200 pero se corta ANTES del primer evento', async () => {
    const s = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n'); setTimeout(() => res.socket.destroy(), 50); });
    const e = await kindOf(call(s.url)); await s.close();
    assert(e.kind === 'unknown', e.kind + ' ' + e.message);
  });
  await check('cut: empezó (message_start) y se cortó → se conoce el id y el usage parcial', async () => {
    const s = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse('message_start', start)); res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'parcial' } })); setTimeout(() => res.socket.destroy(), 50); });
    const e = await kindOf(call(s.url)); await s.close();
    assert(e.kind === 'cut' && e.extra.messageId === 'msg_1' && e.extra.usage.input_tokens === 100, JSON.stringify(e.extra));
  });
  await check('cut: evento error (overloaded) A MITAD del stream; http 529 si llega ANTES de generar', async () => {
    let s = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse('message_start', start)); res.end(sse('error', { error: { type: 'overloaded_error' } })); });
    let e = await kindOf(call(s.url)); await s.close();
    assert(e.kind === 'cut', e.kind);
    s = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse('error', { error: { type: 'overloaded_error' } })); });
    e = await kindOf(call(s.url)); await s.close();
    assert(e.kind === 'http' && e.extra.status === 529, e.kind + ' ' + JSON.stringify(e.extra));
  });
  await check('inactividad: sin bytes más que idleMs → cut si había empezado, unknown si no (nunca cuelga)', async () => {
    let s = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse('message_start', start)); });
    const t0 = Date.now();
    let e = await kindOf(call(s.url, { idleMs: 300 })); await s.close();
    assert(e.kind === 'cut' && Date.now() - t0 < 3000, e.kind);
    s = await server(() => { /* nunca responde */ });
    e = await kindOf(call(s.url, { idleMs: 300 })); await s.close();
    assert(e.kind === 'unknown', e.kind);
  });
  await check('largo: un stream de 2,5 s con bytes cada 200 ms y idle 1 s → completo (no hay tope de 100 s ni de inactividad mientras fluye)', async () => {
    const s = await server(async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse('message_start', start));
      for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 200)); res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } })); }
      res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } })); res.end(sse('message_stop', {}));
    });
    const r = await call(s.url, { idleMs: 1000 }); await s.close();
    assert(r.text === 'x'.repeat(12), r.text);
  });
  await check('sin message_stop → cut (nunca se acepta una respuesta incompleta)', async () => {
    const s = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse('message_start', start)); res.end(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'a' } })); });
    const e = await kindOf(call(s.url)); await s.close();
    assert(e.kind === 'cut', e.kind);
  });
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
