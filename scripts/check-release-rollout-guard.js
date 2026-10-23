#!/usr/bin/env node
/* eslint-disable */
// Review r1 (I-2) — guarda de promoción a producción (USD 0, sin red, solo lectura).
//   [RG1] deploy.yml (producción) NO decide las variables r58 con default seguro que cambian el v1 (VIDEO_ENGINE_*):
//         AVISO no fatal por cada una (se decide a mano: docs/ops/RELEASE-CHECKLIST.md). Nunca toca configuración.
//   [RG2] el checklist existe y nombra cada variable + el entorno de Cloudflare Pages (fatal si falta: el aviso no
//         tendría a dónde mandar).
//   [RG3] defaults seguros del acceso al Video Engine (dist del backend y, si está al lado, la función del frontend):
//         sin VIDEO_ENGINE_* → status / batch-status abiertos al usuario autenticado; create / batch-create / auth-test no.
// Usage: node scripts/check-release-rollout-guard.js [path/to/dist]
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
let passes = 0;
let failures = 0;
const warnings = [];
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }

/** Variables r58 con default seguro que cambian el comportamiento v1 en producción si nadie decide. */
const ROLLOUT_DECISIONS = ['VIDEO_ENGINE_ENABLED', 'VIDEO_ENGINE_ALLOWED_OWNERS'];

/** Pura: variables de `keys` que el texto del workflow no menciona (ni como env ni en un ensure_env del script remoto). */
function undecidedKeys(workflowText, keys = ROLLOUT_DECISIONS) {
  const lines = String(workflowText).split('\n').filter((l) => !/^\s*#/.test(l));
  const body = lines.join('\n');
  return keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(body));
}

(async () => {
  await check('RG1 deploy.yml de producción: VIDEO_ENGINE_* sin decidir → aviso (no fatal); la función pura detecta claves ausentes / presentes / comentadas', () => {
    eq(undecidedKeys('env:\n  VIDEO_ENGINE_ENABLED: "true"\n'), ['VIDEO_ENGINE_ALLOWED_OWNERS'], 'una decidida');
    eq(undecidedKeys('# VIDEO_ENGINE_ENABLED=true\n# VIDEO_ENGINE_ALLOWED_OWNERS=*\n'), ROLLOUT_DECISIONS, 'comentadas no cuentan');
    eq(undecidedKeys("ensure_env_exact VIDEO_ENGINE_ENABLED true\nensure_env_exact VIDEO_ENGINE_ALLOWED_OWNERS '*'\n"), [], 'ambas decididas');
    const wf = path.join(REPO, '.github/workflows/deploy.yml');
    assert(fs.existsSync(wf), 'falta .github/workflows/deploy.yml');
    const missing = undecidedKeys(fs.readFileSync(wf, 'utf8'));
    for (const k of missing) warnings.push(`deploy.yml (producción) no decide ${k}: el primer deploy a main usa el default seguro (v1 video cerrado) — decidir a mano según docs/ops/RELEASE-CHECKLIST.md §1 (backend .env + Cloudflare Pages)`);
  });

  await check('RG2 docs/ops/RELEASE-CHECKLIST.md nombra cada decisión, ambos entornos (backend .env + Cloudflare Pages) y status/batch-status abiertos', () => {
    const p = path.join(REPO, 'docs/ops/RELEASE-CHECKLIST.md');
    assert(fs.existsSync(p), 'falta docs/ops/RELEASE-CHECKLIST.md');
    const t = fs.readFileSync(p, 'utf8');
    for (const k of ROLLOUT_DECISIONS) assert(t.includes(k), `el checklist no nombra ${k}`);
    assert(/Cloudflare Pages/.test(t) && /\.env/.test(t), 'el checklist debe cubrir Pages y el .env del backend');
    assert(/`status`/.test(t) && /`batch-status`/.test(t), 'el checklist explica que status / batch-status siguen abiertos');
  });

  await check('RG3 defaults seguros del Video Engine (backend dist + función del frontend si está al lado)', async () => {
    let VA = null;
    try { VA = require(path.join(distRoot, 'video-engine/video-engine-access.js')); } catch (e) { console.log(`   (dist no disponible: se omite el backend — ${e.message.split('\n')[0]})`); }
    const U = { id: '11111111-2222-4333-8444-555555555555', email: 'u@x.test' };
    if (VA) {
      const d = (action, payload = {}) => VA.decideVideoEngineAccess({ action, payload, user: U }, {});
      eq([d('status', { job_id: 'j1' }).allow, d('batch-status', { batch_id: 'b1' }).allow], [true, true], 'backend: lectura abierta');
      eq([d('create').status, d('batch-create').status, d('auth-test').status], [403, 403, 403], 'backend: render / auth-test cerrados');
    }
    const fe = path.resolve(REPO, '..', 'fe', 'functions', 'api', 'video-engine.js');
    if (!fs.existsSync(fe)) { console.log('   (frontend no disponible: se omite)'); return; }
    const M = await import(require('url').pathToFileURL(fe).href);
    const jwt = { sub: U.id, email: U.email, email_verified: true };
    eq([M.decideVideoEngineAccess('status', jwt, {}, { job_id: 'j1' }).allow, M.decideVideoEngineAccess('batch-status', jwt, {}, { batch_id: 'b1' }).allow], [true, true], 'frontend: lectura abierta');
    eq([M.decideVideoEngineAccess('create', jwt, {}).status, M.decideVideoEngineAccess('auth-test', jwt, {}).status], [403, 403], 'frontend: render / auth-test cerrados');
    eq(M.decideVideoEngineAccess('status', { sub: '' }, {}, {}).status, 403, 'frontend: lectura exige sesión');
    eq(M.decideVideoEngineAccess('status', jwt, {}, { job_id: '../../x' }).status, 400, 'frontend: id inválido');
    eq(M.decideVideoEngineAccess('create', jwt, { VIDEO_ENGINE_ALLOWED_OWNERS: '*', VIDEO_ENGINE_ENABLED: 'true' }).allow, true, 'frontend: opt-in explícito');
  });

  for (const w of warnings) console.warn(`⚠️  ${w}`);
  console.log(`\n${passes} OK, ${failures} fallidos, ${warnings.length} aviso(s) (no fatales)`);
  process.exit(failures ? 1 : 0);
})();

