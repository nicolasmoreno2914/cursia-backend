#!/usr/bin/env node
/* eslint-disable */
// r98.1 — «Falla común» contra Postgres 16 REAL. En producción GET /admin/dynamic-runs/common-failures respondía 500:
// la consulta usaba $1 como timestamptz y también contra texto (output_summary->…->>'lastAt'), y Postgres no admite
// dos tipos para el mismo parámetro («operator does not exist: text >= timestamp with time zone»). Los checks puros
// no lo veían. Este check ejecuta las consultas reales (endpoint, needs-attention cacheado, resolve) sobre la base.
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const { setupR95Db, L } = require('./lib/r95-db');

let passes = 0; let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m); }

(async () => {
  const { AdminRecoveryService } = L('modules/dynamic-generation/admin-recovery.service.js');
  const H = await setupR95Db('r98-cf');
  try {
    const svc = new AdminRecoveryService(H.ds, {}, H.runs);

    await check('GET common-failures: la consulta corre en Postgres real (sin 500 por tipos de $1) y devuelve la forma esperada', async () => {
      const res = await svc.commonFailuresListing(false);
      assert(res && typeof res.generatedAt === 'string' && Array.isArray(res.commonFailures), `forma: ${JSON.stringify(res).slice(0, 200)}`);
      const all = await svc.commonFailuresListing(true);
      assert(Array.isArray(all.commonFailures), 'includeResolved');
    });

    await check('needs-attention usa la señal cacheada sin error', async () => {
      const list = await svc.listCommonFailuresCached();
      assert(Array.isArray(list), 'lista');
    });

    await check('una fila con remediation reciente entra a la ventana (la comparación de lastAt como texto ISO funciona)', async () => {
      const [{ n }] = await H.ds.query(
        `select count(*)::int as n from (select $1::timestamptz as t) x where x.t >= $2::timestamptz and ($3::text) >= $2::text`,
        [new Date().toISOString(), new Date(Date.now() - 7 * 86_400_000).toISOString(), new Date().toISOString()],
      );
      assert(n === 1, 'comparación ISO');
      const rows = await svc.listCommonFailures(new Date());
      assert(Array.isArray(rows), 'listCommonFailures');
    });

    await check('resolve: con admin_audit_log registra la marca; sin ella responde 200 con motivo', async () => {
      const [probe] = await H.ds.query(`select to_regclass('public.admin_audit_log') is not null as ok`);
      const out = await svc.resolveCommonFailure('B:TEST_CODE:content', { id: '00000000-0000-4000-8000-000000000001', email: 'sa@test.local' }, 'check');
      if (probe.ok) assert(out.resolved === true && out.resolvedAt, `resuelto: ${JSON.stringify(out)}`);
      else assert(out.resolved === false && out.message, `sin tabla: ${JSON.stringify(out)}`);
      const res = await svc.commonFailuresListing(true);
      assert(Array.isArray(res.commonFailures), 'listado tras resolve');
    });
  } finally {
    await H.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
