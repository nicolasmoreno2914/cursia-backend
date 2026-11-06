#!/usr/bin/env node
/* eslint-disable */
// r103 · El correo de invitación (Administración → «Invitar») vuelve SIEMPRE a la app real, contra el código COMPILADO
// en dist/ ("npm run build" antes). USD 0: sin red real (fetch simulado), sin DB.
//
//   IR1  inviteRedirectUrl: AUTH_INVITE_REDIRECT_URL manda; si falta, FRONTEND_URL; barra final fuera; sin valor → null
//   IR2  valores no válidos → null (http público, javascript:, con espacios, con query/hash); http://localhost solo con
//        un Supabase local (127.0.0.1), nunca contra el Supabase real
//   IR3  inviteUser pide POST /auth/v1/invite?redirect_to=<url codificada> con el mismo cuerpo de siempre
//   IR4  sin URL configurada: POST /auth/v1/invite sin query (comportamiento anterior)
//
// Uso: node scripts/check-r103-invite-redirect.js [path/to/dist]
'use strict';
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
let SA;
try { SA = require(path.join(DIST, 'modules/access/supabase-admin.client.js')); } catch (e) { console.error(`❌ No se pudo cargar supabase-admin.client.js de ${DIST} (¿corriste "npm run build"?): ${e.message}`); process.exit(1); }
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };

async function invited(env) {
  const saved = {};
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AUTH_INVITE_REDIRECT_URL', 'FRONTEND_URL'];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' }, env);
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: '11111111-1111-4111-8111-111111111111', email: 'a@b.co', created_at: '2026-11-06T00:00:00Z' }) };
  };
  try {
    await new SA.SupabaseAdminClient().inviteUser('a@b.co', { full_name: 'A' });
  } finally {
    global.fetch = realFetch;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return calls;
}

(async () => {
  const f = SA.inviteRedirectUrl;
  await check('IR1 AUTH_INVITE_REDIRECT_URL manda, luego FRONTEND_URL, sin barra final; nada → null', () => {
    eq(f({ AUTH_INVITE_REDIRECT_URL: 'https://cursia.nomaddi.com/', FRONTEND_URL: 'https://otra.example' }), 'https://cursia.nomaddi.com');
    eq(f({ FRONTEND_URL: 'https://cursia.nomaddi.com' }), 'https://cursia.nomaddi.com');
    eq(f({ FRONTEND_URL: 'https://staging.orbia.pages.dev//' }), 'https://staging.orbia.pages.dev');
    eq(f({}), null);
    eq(f({ FRONTEND_URL: '   ' }), null);
  });
  await check('IR2 valores no válidos → null; http://localhost solo con Supabase local', () => {
    for (const v of ['http://cursia.nomaddi.com', 'javascript:alert(1)', 'https://a b.com', 'https://cursia.nomaddi.com/?x=1', 'https://cursia.nomaddi.com/#a', 'ftp://x']) eq(f({ FRONTEND_URL: v }), null, v);
    eq(f({ FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co' }), null, 'localhost con Supabase real');
    eq(f({ FRONTEND_URL: 'http://localhost:5173' }), null, 'localhost sin Supabase');
    eq(f({ FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'http://127.0.0.1:54321' }), 'http://localhost:5173');
  });
  await check('IR3 inviteUser → POST /auth/v1/invite?redirect_to=… con el cuerpo de siempre', async () => {
    const c = await invited({ FRONTEND_URL: 'https://cursia.nomaddi.com' });
    eq(c.length, 1);
    eq(c[0].method, 'POST');
    eq(c[0].url, 'https://example.supabase.co/auth/v1/invite?redirect_to=' + encodeURIComponent('https://cursia.nomaddi.com'));
    eq(c[0].body, { email: 'a@b.co', data: { full_name: 'A' } });
  });
  await check('IR4 sin URL configurada → POST /auth/v1/invite sin query', async () => {
    const c = await invited({});
    eq(c[0].url, 'https://example.supabase.co/auth/v1/invite');
  });
  console.log(`\n${ok} ok · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
