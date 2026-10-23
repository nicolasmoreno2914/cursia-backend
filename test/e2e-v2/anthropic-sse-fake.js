// Loop 4 — Anthropic FALSO con streaming SSE (127.0.0.1, USD 0) para el worker de IA del backend.
// Responde con el MISMO LLM falso de la E2E (llm.respond: salidas válidas para los validadores) y deja inyectar,
// por regla sobre el texto del prompt:
//   - slow  : el stream dura `totalMs` (p. ej. 105 s: más que el corte de 100 s de Cloudflare);
//   - drop  : recibe el pedido y cierra la conexión SIN responder (resultado DESCONOCIDO);
//   - cut   : empieza el stream (message_start + parte del texto) y corta (cobrado, incompleto);
//   - hold  : recibe y no responde nunca (para matar al worker en vuelo).
// r64: un pedido SIN streaming (`stream: false`) recibe el mensaje entero en JSON. `cut` solo existe en el stream
// (una respuesta JSON no se corta a mitad: llega entera o falla); `drop`/`hold`/`slow` valen igual.
'use strict';
const http = require('http');
const crypto = require('crypto');

function promptText(body) {
  const c = body && body.messages && body.messages[0] && body.messages[0].content;
  return Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : String(c || '');
}

function startAnthropicSseFake(llm) {
  const st = { requests: [], rules: [], served: 0 };
  const sockets = new Set();
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* cuerpo inválido */ }
    const text = promptText(body);
    const rec = { at: Date.now(), end: null, text, maxTokens: body.max_tokens, stream: body.stream === true, outcome: 'pending', key: req.headers['x-api-key'] };
    st.requests.push(rec);
    const rule = st.rules.find((r) => r.times > 0 && r.match(text, body));
    if (rule) rule.times--;
    const action = rule ? rule.action : 'ok';
    rec.action = action;
    if (action === 'drop') { rec.outcome = 'dropped'; rec.end = Date.now(); req.socket.destroy(); return; }
    if (action === 'hold') { rec.outcome = 'held'; return; }
    const out = llm.respond(body, {});
    // Loop 7: `transform` modifica la respuesta válida del LLM falso (p. ej. mete una oración con un dato inventado).
    if (action === 'transform' && typeof rule.fn === 'function') out.text = rule.fn(String(out.text || ''));
    if (out.httpStatus && out.httpStatus !== 200) {
      rec.outcome = `http_${out.httpStatus}`; rec.end = Date.now();
      res.writeHead(out.httpStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: out.error || 'fake' } }));
      return;
    }
    const id = `msg_sse_${++st.served}_${crypto.randomUUID().slice(0, 8)}`;
    rec.messageId = id;
    if (body.stream !== true) {
      if (action === 'slow' && rule.totalMs) await new Promise((r) => setTimeout(r, rule.totalMs));
      const fullJ = String(out.text || '');
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_json_${st.served}` });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: fullJ }], stop_reason: out.stopReason || 'end_turn', stop_sequence: null,
        usage: { input_tokens: Math.max(1, Math.ceil(raw.length / 4)), output_tokens: Math.max(1, Math.ceil(fullJ.length / 4)), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
      rec.outcome = 'ok'; rec.end = Date.now();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': `req_sse_${st.served}` });
    const send = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
    const full = String(out.text || '');
    const inTok = Math.max(1, Math.ceil(raw.length / 4));
    send('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: inTok, output_tokens: 1 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    // Un corte necesita al menos 2 trozos (se corta a la mitad, después del primero).
    const n = Math.max(action === 'cut' ? 2 : 1, Math.min(40, Math.ceil(full.length / 400)));
    const size = Math.ceil(full.length / n);
    const per = action === 'slow' ? Math.max(0, Math.floor(rule.totalMs / n)) : 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < n; i++) {
      if (action === 'cut' && i >= Math.max(1, Math.floor(n / 2))) {
        // Deja que message_start y el texto parcial lleguen al cliente antes de cortar (si no, es un DESCONOCIDO).
        await sleep(60);
        rec.outcome = 'cut'; rec.end = Date.now(); res.socket.destroy(); return;
      }
      // Stream lento como el real: nunca queda mudo (Anthropic manda tokens y `ping` todo el tiempo).
      for (let left = per; left > 0; left -= 1000) {
        await sleep(Math.min(1000, left));
        if (res.destroyed) break;
        send('ping', {});
      }
      if (res.destroyed) { rec.outcome = 'client_gone'; rec.end = Date.now(); return; }
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: full.slice(i * size, (i + 1) * size) } });
    }
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: out.stopReason || 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(full.length / 4)) } });
    send('message_stop', {});
    res.end();
    rec.outcome = 'ok'; rec.end = Date.now();
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    st,
    rule(match, action, times = 1, totalMs = 0, fn) { const r = { match, action, times, totalMs, fn }; st.rules.push(r); return r; },
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  })));
}

module.exports = { startAnthropicSseFake, promptText };
