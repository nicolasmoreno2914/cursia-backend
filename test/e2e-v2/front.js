// Carga el código REAL del frontend (worktree v2-integration) en un vm
// sandbox (mismo patrón que int-r2/regress/t6a), con:
//  - 24-backend-client.js real, activado por el camino documentado de staging
//    (localStorage CURSIA_BACKEND_ENABLED/URL) apuntando al Nest local;
//  - 04-api.js real: su api() hace fetch('/api/proxy') → el LLM falso
//    determinístico (llm.js) responde en formato Messages API;
//  - SB (supabase-js) = shim mínimo que habla HTTP con el Storage falso;
//  - fetch del sandbox: solo 127.0.0.1 (+ /api/proxy), cualquier otra URL se
//    bloquea y se registra.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const FILES = [
  'src/js/04-api.js',
  'src/js/05-libro.js',
  'src/js/06-scorms.js',
  'src/js/06b-scorm-templates.js',
  'src/js/42-scorm-templates-ui.js',
  'src/js/07-examenes.js',
  'src/js/08-downloads.js',
  'src/js/44-dynamic-prompt-builders.js',
  'src/js/46-dynamic-context-package.js',
  'src/js/24-backend-client.js',
  'src/js/45-dynamic-generation-executor.js',
];

function makeFront({ feRoot, backendUrl, storageUrl, token, ownerId, llm, logFile, netViolations }) {
  const noop = function () {};
  const stubEl = () => ({
    addEventListener: noop, removeEventListener: noop, appendChild: noop, insertBefore: noop, removeChild: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {}, children: [], options: [], querySelector: () => null, querySelectorAll: () => [],
    setAttribute: noop, getAttribute: () => null, remove: noop, focus: noop, click: noop,
    disabled: false, textContent: '', innerHTML: '', value: '', checked: false,
  });
  const document = {
    getElementById: () => stubEl(), querySelector: () => stubEl(), querySelectorAll: () => [],
    createElement: () => stubEl(), addEventListener: noop, body: stubEl(), documentElement: stubEl(), head: stubEl(),
    readyState: 'complete',
  };
  const ls = new Map([['CURSIA_BACKEND_ENABLED', 'true'], ['CURSIA_BACKEND_URL', backendUrl]]);
  const storageApi = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k),
    key: () => null, get length() { return ls.size; },
  };
  const log = (lvl) => (...a) => fs.appendFileSync(logFile, `[${lvl}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  const realFetch = global.fetch;
  const sandbox = {
    document,
    console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: noop },
    navigator: { userAgent: 'node-e2e', clipboard: { writeText: () => Promise.resolve() } },
    localStorage: storageApi,
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { hostname: 'staging.orbia.pages.dev', href: 'https://staging.orbia.pages.dev/', origin: 'https://staging.orbia.pages.dev', protocol: 'https:' },
    alert: noop, confirm: () => false, prompt: () => null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Blob, FormData, AbortController, TextEncoder, TextDecoder,
    GEN_STOPPED: false,
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error, TypeError, Promise, Map, Set, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, escape, unescape, atob, btoa,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = noop;
  // 01-state.js globals que 42 lee al cargar (render inicial del picker).
  sandbox.SEL = { scormTemplates: 'auto' };
  sandbox.D = {};
  sandbox.SB_USER = { id: ownerId, email: 'e2e@example.com' };
  sandbox.SB = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: token, user: { id: ownerId } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: noop } } }),
    },
    storage: {
      from: (bucket) => ({
        upload: async (storagePath, blob, opts) => {
          const buf = Buffer.from(await blob.arrayBuffer());
          const r = await realFetch(`${storageUrl}/storage/v1/object/${bucket}/${storagePath}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': (opts && opts.contentType) || 'application/octet-stream', 'x-upsert': String(!!(opts && opts.upsert)) },
            body: buf,
          });
          if (!r.ok) return { data: null, error: { message: `HTTP ${r.status} ${await r.text()}` } };
          return { data: { path: storagePath }, error: null };
        },
        createSignedUrl: async (storagePath, expiresIn) => {
          const r = await realFetch(`${storageUrl}/storage/v1/object/sign/${bucket}/${storagePath}`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn }),
          });
          if (!r.ok) return { data: null, error: { message: `HTTP ${r.status}` } };
          const j = await r.json();
          return { data: { signedUrl: `${storageUrl}/storage/v1${j.signedURL}` }, error: null };
        },
      }),
    },
  };
  sandbox.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url === '/api/proxy') {
      const body = JSON.parse((init && init.body) || '{}');
      const out = llm.respond(body);
      if (out.httpStatus && out.httpStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: out.error || 'fake llm error' } }), { status: out.httpStatus, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: out.text }], stop_reason: out.stopReason || 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return realFetch(input, init);
    netViolations.push(url);
    throw new TypeError(`E2E: red bloqueada en el navegador simulado: ${url}`);
  };
  vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(feRoot, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

/** Contexto vm PURO (44 + 46) para recomputar Context Packages sin red. */
function pureCtx(feRoot) {
  const c = { console, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, isFinite };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(feRoot, 'src/js/44-dynamic-prompt-builders.js'), 'utf8'), c, { filename: '44' });
  vm.runInContext(fs.readFileSync(path.join(feRoot, 'src/js/46-dynamic-context-package.js'), 'utf8'), c, { filename: '46' });
  return c;
}

module.exports = { makeFront, pureCtx };
