/* eslint-disable */
// r62 (M) — proxy de fallas para la prueba de autonomía (scripts/check-r62-autonomy-e2e.js). Solo 127.0.0.1, USD 0.
//
// Se pone DELANTE de un proveedor falso (Anthropic SSE, Gamma/OpenAI/Anthropic de fakes.js, Videogen) y:
//   - cuenta cada llamada PAGADA por CLAVE LÓGICA (mismo pedido = misma clave) y si el proveedor la «cobró»
//     (el falso de atrás la procesó con 200, aunque el cliente nunca haya recibido la respuesta);
//   - inyecta fallas por regla (match sobre método/ruta/cuerpo/orden), sin tocar los fakes ni el producto:
//       {status}        responde ese HTTP SIN reenviar (529/429/500…; no cobrado)
//       'reset'         corta la conexión al recibir el pedido, SIN reenviar (ECONNRESET; no cobrado)
//       'hang'          recibe y nunca responde ni reenvía (cuelgue; no cobrado; el cliente corta por timeout)
//       'forward_hang'  reenvía (el proveedor lo procesa y COBRA) y nunca responde (timeout con cobro)
//       'forward_reset' reenvía, el proveedor COBRA, y se corta la conexión antes de entregar (facturación incierta)
//       'delay'         reenvía en el acto (cobra al terminar) y entrega la respuesta `ms` después (llamada en vuelo)
//       'rewrite'       reenvía y reescribe el JSON de la respuesta con `fn` (p. ej. un job de Videogen que falla)
//   - sin regla: pasa tal cual, en streaming (SSE intacto).
'use strict';
const http = require('http');
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

/** Clave lógica + tipo de una llamada pagada (null = no pagada: polls, exports, descargas). */
function paidKeyOf(method, path, raw) {
  if (method !== 'POST') return null;
  let b = {};
  try { b = JSON.parse(raw || '{}'); } catch { b = {}; }
  if (path === '/v1/messages') {
    const { metadata, stream, ...rest } = b;
    return { kind: 'anthropic', key: sha(JSON.stringify(rest)) };
  }
  if (path === '/v1/audio/speech') return { kind: 'openai_tts', key: sha(`${b.model}|${b.voice}|${b.input}`) };
  if (path === '/generations') return { kind: 'gamma', key: sha(JSON.stringify(b)) };
  if (path === '/api/external/videos/batch-create') return { kind: 'videogen', key: sha((b.videos || []).map((v) => String(v.client_reference_id)).sort().join(',')) };
  return null;
}

function startFaultProxy(name, upstreamBase) {
  const up = new URL(upstreamBase);
  const st = { name, calls: [], rules: [], scenario: null, counts: new Map() };
  const sockets = new Set();
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf8');
      const u = new URL(rq.url, 'http://x');
      const pk = paidKeyOf(rq.method, u.pathname, text);
      const sig = `${rq.method} ${u.pathname}`;
      const n = (st.counts.get(sig) || 0) + 1;
      st.counts.set(sig, n);
      // `text` = texto plano del pedido (todas las cadenas del JSON decodificadas: prompts sin escapes).
      let plain = text;
      try { const acc = []; const walk = (v) => { if (typeof v === 'string') acc.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x); }; walk(JSON.parse(text)); plain = acc.join('\n'); } catch { /* no JSON */ }
      const info = { method: rq.method, path: u.pathname, text: plain, raw: text, n };
      const rule = st.rules.find((r) => r.times > 0 && r.match(info));
      if (rule) rule.times--;
      const action = rule ? rule.action : 'pass';
      const rec = { at: Date.now(), end: null, scenario: st.scenario, sig, kind: pk && pk.kind, key: pk && pk.key, action: typeof action === 'number' ? `http_${action}` : action, rule: rule && rule.label, outcome: 'pending', billed: false, upstreamStatus: null, snippet: text.slice(0, 160) };
      st.calls.push(rec);
      let clientGone = false;
      rs.on('close', () => { if (!rs.writableEnded) clientGone = true; });
      const done = (outcome) => { rec.outcome = outcome; rec.end = Date.now(); };
      if (typeof action === 'number') {
        const headers = { 'content-type': 'application/json', ...(rule.headers || {}) };
        rs.writeHead(action, headers);
        rs.end(JSON.stringify(rule.body || { type: 'error', error: { type: action === 529 ? 'overloaded_error' : action === 429 ? 'rate_limit_error' : 'api_error', message: `r62 fault ${action}` } }));
        return done('rejected');
      }
      if (action === 'reset') { rq.socket.destroy(); return done('reset'); }
      if (action === 'hang') { rec.outcome = 'hang'; rs.on('close', () => { rec.end = Date.now(); }); return; }
      // Reenvío al proveedor falso de atrás.
      const headers = { ...rq.headers, host: up.host };
      delete headers['content-length'];
      headers['content-length'] = String(raw.length);
      const pr = http.request({ hostname: up.hostname, port: up.port, method: rq.method, path: rq.url, headers }, (pres) => {
        rec.upstreamStatus = pres.statusCode;
        const billable = !!pk && pres.statusCode === 200;
        const buffered = action !== 'pass';
        const body = [];
        if (!buffered) {
          if (!clientGone) rs.writeHead(pres.statusCode, pres.headers);
        }
        pres.on('data', (c) => { if (buffered) body.push(c); else if (!clientGone) rs.write(c); });
        pres.on('end', () => {
          rec.billed = billable;
          if (!buffered) { if (!clientGone) { rs.end(); done('served'); } else done(billable ? 'served_lost' : 'lost'); return; }
          const buf = Buffer.concat(body);
          const hdr = (len) => { const h = { ...pres.headers }; delete h['transfer-encoding']; h['content-length'] = String(len); return h; };
          if (action === 'forward_hang') { done(billable ? 'served_lost' : 'lost'); return; }
          if (action === 'forward_reset') { rq.socket.destroy(); done(billable ? 'served_lost' : 'lost'); return; }
          if (action === 'rewrite') {
            let out = buf;
            try { out = Buffer.from(JSON.stringify(rule.fn(JSON.parse(buf.toString('utf8')), info))); } catch { /* no JSON: tal cual */ }
            const h = hdr(out.length);
            if (clientGone) return done('lost');
            rs.writeHead(pres.statusCode, h); rs.end(out); return done('served');
          }
          if (action === 'delay') {
            setTimeout(() => {
              if (clientGone || rs.destroyed) return done(billable ? 'served_lost' : 'lost');
              rs.writeHead(pres.statusCode, hdr(buf.length));
              rs.end(buf); done('served');
            }, rule.ms || 0);
            return;
          }
          rs.writeHead(pres.statusCode, hdr(buf.length)); rs.end(buf); done('served');
        });
        pres.on('error', () => done('upstream_error'));
      });
      pr.on('error', (e) => { done(`upstream_error:${e.code || e.message}`); if (!clientGone) { rs.writeHead(502); rs.end('bad gateway'); } });
      pr.end(raw);
    });
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    st,
    /** Agrega una regla: match(info) con info = {method, path, text, n(orden de esa ruta)}. */
    rule(label, match, action, extra = {}) { const r = { label, match, action, times: extra.times ?? 1, ...extra }; st.rules.push(r); return r; },
    reset(scenario) { st.rules.length = 0; st.scenario = scenario; st.counts.clear(); },
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  })));
}

/**
 * Llamadas pagadas duplicadas de un escenario: por clave lógica, cuántas veces el proveedor COBRÓ. >1 = cobro
 * duplicado. `ambiguousThenPaid`: una llamada cuyo resultado el cliente no conoció (cuelgue/reset/timeout) y que
 * después se volvió a enviar y se cobró (riesgo de doble cobro con un proveedor real que sí la procesó).
 */
function duplicateReport(calls) {
  const by = new Map();
  for (const c of calls) {
    if (!c.key) continue;
    if (!by.has(c.key)) by.set(c.key, []);
    by.get(c.key).push(c);
  }
  const dup = [];
  const ambiguousThenPaid = [];
  for (const [key, cs] of by) {
    const billed = cs.filter((c) => c.billed);
    if (billed.length > 1) dup.push({ key, kind: cs[0].kind, billed: billed.length, outcomes: cs.map((c) => c.outcome), snippet: cs[0].snippet.slice(0, 90) });
    const amb = cs.findIndex((c) => ['hang', 'reset'].includes(c.outcome));
    if (amb >= 0 && cs.slice(amb + 1).some((c) => c.billed)) ambiguousThenPaid.push({ key, kind: cs[0].kind, outcomes: cs.map((c) => c.outcome) });
  }
  return { dup, ambiguousThenPaid, paidCalls: calls.filter((c) => c.billed).length };
}

module.exports = { startFaultProxy, duplicateReport, paidKeyOf };
