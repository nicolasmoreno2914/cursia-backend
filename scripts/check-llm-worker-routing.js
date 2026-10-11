#!/usr/bin/env node
/* eslint-disable */
// Loop 4 (review I7/M5): el navegador solo deja de reclamar las partes largas que cubre un worker de IA VIVO.
// Usage: npm run build && node scripts/check-llm-worker-routing.js [dist]
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const R = require(path.join(distRoot, 'modules/dynamic-generation/llm-worker-routing.js'));

let passes = 0; let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const ALL = ['course_plan', 'content', 'experience', 'activity', 'application_activity', 'final_exam', 'exam'];
const ON = { DYNAMIC_LLM_WORKER_ENABLED: 'true' };

(async () => {
  await check('flag apagado → el navegador reclama todo (aunque haya un worker vivo)', async () => {
    assert(R.browserEffectiveTypes(ALL, new Set(['content']), {}).join() === ALL.join(), 'sin cambios');
  });
  await check('flag encendido SIN worker vivo → el navegador sigue reclamando todo (nunca queda colgado)', async () => {
    assert(R.browserEffectiveTypes(ALL, new Set(), ON).join() === ALL.join(), 'sin cambios');
  });
  await check('flag encendido con worker vivo → solo se quitan los tipos que ESE worker cubre', async () => {
    assert(R.browserEffectiveTypes(ALL, new Set(['content', 'experience']), ON).join() === 'course_plan,activity,application_activity,final_exam,exam', 'filtrado parcial');
  });
  await check('presencia: tabla ausente / error de DB → ningún tipo vivo', async () => {
    R.resetLlmWorkerPresenceCacheForTests();
    const s = await R.liveLlmWorkerTypes({ query: async () => { throw new Error('relation "public.llm_worker_presence" does not exist'); } });
    assert(s.size === 0, 'vacío');
  });
  await check('presencia: filas vivas → sus tipos; cache de 5 s', async () => {
    R.resetLlmWorkerPresenceCacheForTests();
    let calls = 0; let sql = '';
    const ds = { query: async (q) => { calls++; sql = q; return [{ t: 'content' }, { t: 'final_exam' }]; } };
    const t0 = Date.now();
    const s = await R.liveLlmWorkerTypes(ds, t0);
    await R.liveLlmWorkerTypes(ds, t0 + 1000);
    assert([...s].sort().join() === 'content,final_exam' && calls === 1, 'cacheado');
    assert(!/not draining/.test(sql) && /last_seen > now\(\)/.test(sql), 'vivos por latido (un worker drenando sigue cubriendo: deploy)');
    await R.liveLlmWorkerTypes(ds, t0 + 6000);
    assert(calls === 2, 'vence la cache');
  });
  await check('M5: DYNAMIC_LLM_WORKER_TYPES inválido → error (el worker no arranca con otro set); default y deduplicado', async () => {
    let threw = false;
    try { R.llmWorkerTypes({ DYNAMIC_LLM_WORKER_TYPES: 'content,video' }); } catch { threw = true; }
    assert(threw, 'tipo desconocido lanza');
    assert(R.llmWorkerTypes({}).join() === 'content,application_activity,experience,final_exam', 'default');
    assert(R.llmWorkerTypes({ DYNAMIC_LLM_WORKER_TYPES: 'content, content ,experience' }).join() === 'content,experience', 'dedupe');
  });
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
