// Preload (NODE_OPTIONS=--require) SOLO del E2E, para el app Nest y el
// dynamic-item-worker de la fase YouTube (DN-1): reescribe las llamadas a
// Google (OAuth token + YouTube Data API v3, incluida la subida resumable) al
// Google FALSO local de fakes.js ($E2E_GOOGLE_FAKE_BASE, http://127.0.0.1:<port>).
// Sin esta variable no hace nada. Todo lo demás sigue pasando por netguard.js
// (cualquier conexión fuera de 127.0.0.1 se bloquea). No es código de producto.
'use strict';
const BASE = process.env.E2E_GOOGLE_FAKE_BASE;
if (BASE && /^http:\/\/127\.0\.0\.1:\d+$/.test(BASE) && typeof globalThis.fetch === 'function') {
  const orig = globalThis.fetch;
  const MAP = [
    ['https://oauth2.googleapis.com/token', `${BASE}/token`],
    ['https://www.googleapis.com/youtube/v3/', `${BASE}/youtube/v3/`],
    ['https://www.googleapis.com/upload/youtube/v3/', `${BASE}/upload/youtube/v3/`],
  ];
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    for (const [from, to] of MAP) {
      if (url.startsWith(from)) return orig.call(this, to + url.slice(from.length), init);
    }
    return orig.call(this, input, init);
  };
}
