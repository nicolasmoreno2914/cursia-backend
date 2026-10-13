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
const eqSet = (set, arr, m) => { const a = [...set].sort().join(); const b = [...arr].sort().join(); if (a !== b) throw new Error(`${m}: ${a} ≠ ${b}`); };
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
    assert(R.llmWorkerTypes({}).join() === 'course_plan,course_intro,module_intro,content,experience,video_interactions,activity,application_activity,exam,final_exam', 'default (Loop 9: todas las partes de IA v3)');
    assert(R.llmWorkerTypes({ DYNAMIC_LLM_WORKER_TYPES: 'content, content ,experience' }).join() === 'content,experience', 'dedupe');
  });
  await check('Loop 9: el worker cubre TODAS las partes de IA v3 (también las cortas); el env solo puede ACOTAR; nunca scorm ni proveedores', async () => {
    const all = ['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'video_interactions', 'activity', 'application_activity', 'exam', 'final_exam'];
    eqSet(R.DEFAULT_LLM_WORKER_TYPES, all, 'default = todas');
    eqSet(R.ALL_LLM_WORKER_TYPES, all, 'permitidos = todas');
    // Acotar sigue funcionando (p. ej. volver al set de partes largas de Loop 6).
    assert(R.llmWorkerTypes({ DYNAMIC_LLM_WORKER_TYPES: R.LONG_LLM_WORKER_TYPES.join(',') }).join() === 'course_plan,content,application_activity,experience,final_exam', 'acotar a las largas');
    assert(R.llmWorkerTypes({ DYNAMIC_LLM_WORKER_TYPES: 'exam,course_intro' }).join() === 'exam,course_intro', 'acotar a cortas');
    for (const bad of ['scorm', 'video', 'presentation', 'audio_welcome', 'audiobook_chapter', 'content,scorm', ',', ' ']) {
      let threw = false;
      try { R.llmWorkerTypes({ DYNAMIC_LLM_WORKER_TYPES: bad }); } catch { threw = bad.trim() !== ''; }
      if (bad.trim() === '') assert(R.llmWorkerTypes({ DYNAMIC_LLM_WORKER_TYPES: bad }).length === all.length, 'vacío = default');
      else assert(threw, `«${bad}» lanza`);
    }
    // Con un worker vivo que cubre todo, el navegador no reclama ninguna parte de IA; con el worker caído, todas.
    const browserV3 = ['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'video_interactions', 'activity', 'application_activity', 'final_exam', 'exam'];
    assert(R.browserEffectiveTypes(browserV3, new Set(all), ON).length === 0, 'worker vivo ⇒ 0 tipos para el navegador');
    assert(R.browserEffectiveTypes(browserV3, new Set(), ON).join() === browserV3.join(), 'worker caído ⇒ el navegador reclama todo (respaldo)');
  });
  await check('Loop 6: instante de activación — ruteo solo con flag + DYNAMIC_LLM_WORKER_SINCE válido; solo runs creados desde entonces', async () => {
    const since = '2026-10-12T00:00:00Z';
    const env = { DYNAMIC_LLM_WORKER_ENABLED: 'true', DYNAMIC_LLM_WORKER_SINCE: since };
    assert(R.llmWorkerSince(env).toISOString() === '2026-10-12T00:00:00.000Z', 'parse');
    assert(R.llmWorkerRoutingActive(env), 'activo');
    for (const bad of ['', 'mañana', '2026-10-12', 'NaN', 'x2026-10-12T00:00:00Z', '2026-10-12T00:00', '2026-10-12T00:00:00']) assert(!R.llmWorkerRoutingActive({ DYNAMIC_LLM_WORKER_ENABLED: 'true', DYNAMIC_LLM_WORKER_SINCE: bad }), `inválido «${bad}» ⇒ sin ruteo`);
    assert(!R.llmWorkerRoutingActive({ DYNAMIC_LLM_WORKER_SINCE: since }), 'sin flag ⇒ sin ruteo');
    assert(R.runRoutedToLlmWorker('2026-10-12T00:00:01Z', env) && R.runRoutedToLlmWorker(new Date(since), env), 'run nuevo (incluye el instante exacto)');
    assert(!R.runRoutedToLlmWorker('2026-10-11T23:59:59Z', env), 'run anterior (p. ej. #1209) ⇒ sigue en el navegador');
    assert(!R.runRoutedToLlmWorker(null, env) && !R.runRoutedToLlmWorker('basura', env), 'sin fecha ⇒ sin ruteo');
    assert(!R.runRoutedToLlmWorker('2026-10-13T00:00:00Z', { DYNAMIC_LLM_WORKER_ENABLED: 'true' }), 'sin instante ⇒ sin ruteo');
  });
  await check('review I2: el API rutea con el instante que PUBLICA cada worker vivo (latido), por run; sin instante publicado no cubre', async () => {
    R.resetLlmWorkerPresenceCacheForTests();
    let sql = '';
    const ds = { query: async (q) => { sql = q; return [{ item_types: ['content', 'experience'], since: new Date('2026-10-12T00:00:00Z') }, { item_types: ['final_exam'], since: '2026-10-13T00:00:00Z' }]; } };
    const cov = await R.liveLlmWorkerCoverage(ds, Date.now());
    assert(/since is not null/.test(sql) && /last_seen > now\(\)/.test(sql), 'solo vivos con instante publicado');
    eqSet(R.routedTypesForRun(cov, '2026-10-12T12:00:00Z'), ['content', 'experience'], 'run entre los dos instantes');
    eqSet(R.routedTypesForRun(cov, new Date('2026-10-14T00:00:00Z')), ['content', 'experience', 'final_exam'], 'run nuevo para ambos');
    eqSet(R.routedTypesForRun(cov, '2026-10-11T00:00:00Z'), [], 'run anterior a todos: el navegador sigue');
    eqSet(R.routedTypesForRun(cov, null), [], 'sin fecha');
    R.resetLlmWorkerPresenceCacheForTests();
    assert((await R.liveLlmWorkerCoverage({ query: async () => { throw new Error('column since does not exist'); } })).length === 0, 'error de DB (o tabla vieja) ⇒ sin cobertura');
  });
  await check('Loop 9: concurrencia del worker de IA — default 2, el env la fija (staging 4), tope duro 6, inválidos → default', async () => {
    assert(R.llmWorkerConcurrency({}) === 2, 'default');
    assert(R.llmWorkerConcurrency({ DYNAMIC_LLM_WORKER_CONCURRENCY: '4' }) === 4, 'staging');
    assert(R.llmWorkerConcurrency({ DYNAMIC_LLM_WORKER_CONCURRENCY: '6' }) === 6, 'tope exacto');
    assert(R.llmWorkerConcurrency({ DYNAMIC_LLM_WORKER_CONCURRENCY: '50' }) === 6, 'recortado al tope');
    for (const bad of ['0', '-3', 'x', '']) assert(R.llmWorkerConcurrency({ DYNAMIC_LLM_WORKER_CONCURRENCY: bad }) === 2, `«${bad}» → default`);
    const fs = require('fs');
    const yml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/deploy-staging.yml'), 'utf8');
    assert(/^\s*ensure_env_exact DYNAMIC_LLM_WORKER_CONCURRENCY 4\s*$/m.test(yml), 'deploy-staging fija DYNAMIC_LLM_WORKER_CONCURRENCY=4 (exacto)');
    const w = fs.readFileSync(path.join(__dirname, '..', 'src/workers/dynamic-llm-worker.ts'), 'utf8');
    assert(/concurrency: llmWorkerConcurrency\(\)/.test(w) && !/readPositiveInt\('DYNAMIC_LLM_WORKER_CONCURRENCY'/.test(w), 'el worker usa el valor con tope');
  });
  await check('Loop 9: serverExecuted (aviso «puedes cerrar la pestaña») solo con flag + worker vivo que cubre TODAS las partes de IA del run', async () => {
    const v3 = ['course_plan', 'course_intro', 'audio_welcome', 'module_intro', 'content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter', 'exam', 'final_exam'];
    const all = new Set(R.ALL_LLM_WORKER_TYPES);
    assert(R.runServerExecuted(v3, all, ON) === true, 'worker vivo con todo ⇒ true');
    assert(R.runServerExecuted(v3, all, {}) === false, 'flag del API apagado ⇒ false');
    assert(R.runServerExecuted(v3, new Set(), ON) === false, 'worker caído (sin cobertura) ⇒ false');
    assert(R.runServerExecuted(v3, new Set(R.LONG_LLM_WORKER_TYPES), ON) === false, 'worker que solo cubre las largas ⇒ false (las cortas siguen en la pestaña)');
    assert(R.runServerExecuted(['content', 'scorm', 'exam', 'video'], all, ON) === false, 'run v1 con scorm (nunca en el worker) ⇒ false');
    assert(R.runServerExecuted(['video', 'presentation'], all, ON) === false, 'sin partes de IA ⇒ false');
    // Con la cobertura real por run: un run anterior a la activación del worker ⇒ false.
    const cov = [{ types: all, since: new Date('2026-10-12T00:00:00Z') }];
    assert(R.runServerExecuted(v3, R.routedTypesForRun(cov, '2026-10-12T01:00:00Z'), ON) === true, 'run nuevo ⇒ true');
    assert(R.runServerExecuted(v3, R.routedTypesForRun(cov, '2026-10-11T01:00:00Z'), ON) === false, 'run anterior a la activación ⇒ false');
  });
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
