#!/usr/bin/env node
/* eslint-disable */
// Language QA (piloto, 2026-10-07): español latinoamericano neutro en todo texto generado. USD 0, sin red ni DB.
//   LQ1 corpus positivo/negativo (scripts/fixtures/language-qa-corpus.json) con el módulo del backend.
//   LQ2 paridad EXACTA con el frontend (src/js/55-language-qa.js): tablas, salidas sobre el corpus y el mismo corpus.
//   LQ3 validación server-side de items v3 (validateV3ItemArtifact): un regionalismo/voseo/«vosotros» invalida el item
//       (reintentable); cursos de idiomas exentos; bibliografía exenta; ids/URLs no se miran.
//   LQ4 capítulo (Markdown) en SchedulerService: el idioma se valida aunque el capítulo no tenga otra validación.
//   LQ5 audiolibro (backend): regla neutra para cualquier país, voseo corregido antes de narrar, regionalismo → error.
// Uso: CURSIA_FRONTEND_REPO=<frontend> node scripts/check-language-qa.js [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
const loadDist = (rel) => require(path.join(DIST, rel));
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };

const L = loadDist('modules/language-qa/language-qa.js');
const CORPUS_PATH = path.join(REPO, 'scripts/fixtures/language-qa-corpus.json');
const C = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const codesOf = (Q, t) => [...new Set(Q.lqaFindings(t).map((h) => h.code))].sort();

(async () => {
  await check(`LQ1 corpus: ${C.positives.length} positivos detectados (y corregidos cuando es seguro); ${C.negatives.length} negativos sin hallazgos ni cambios`, () => {
    for (const p of C.positives) {
      eq(codesOf(L, p.text), [...p.codes].sort(), p.text);
      if (p.fixed) eq(L.lqaFixText(p.text).text, p.fixed, p.text);
    }
    for (const n of C.negatives) {
      eq(L.lqaFindings(n), [], n);
      eq(L.lqaFixText(n).text, n, n);
    }
  });

  await check('LQ2 paridad con el frontend (55-language-qa.js): tablas, salidas sobre el corpus y el mismo corpus', () => {
    const fe = process.env.CURSIA_FRONTEND_REPO;
    if (!fe || !fs.existsSync(path.join(fe, 'src/js/55-language-qa.js'))) throw new Error('CURSIA_FRONTEND_REPO no apunta al frontend (con src/js/55-language-qa.js)');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(fe, 'src/js/55-language-qa.js'), 'utf8'), ctx);
    eq(JSON.parse(JSON.stringify(ctx.LQA_VOSEO_FIX)), L.LQA_VOSEO_FIX, 'tabla de voseo');
    eq(ctx.LQA_REGIONAL.map((r) => [r.re.source, r.re.flags, r.term, r.region, r.hint]), L.LQA_REGIONAL.map((r) => [r.re.source, r.re.flags, r.term, r.region, r.hint]), 'regionalismos');
    eq(ctx.LQA_VOSOTROS_RE.source, L.LQA_VOSOTROS_RE.source, 'vosotros');
    eq(ctx.lqaLanguageRule(), L.lqaLanguageRule(), 'regla del prompt');
    for (const t of [...C.positives.map((p) => p.text), ...C.negatives]) {
      eq(JSON.parse(JSON.stringify(ctx.lqaFindings(t))), L.lqaFindings(t), `findings ${t}`);
      eq(ctx.lqaFixText(t).text, L.lqaFixText(t).text, `fix ${t}`);
    }
    const feCorpus = path.join(fe, 'src/js/__harness__/fixtures/language-qa-corpus.json');
    eq(fs.readFileSync(feCorpus, 'utf8'), fs.readFileSync(CORPUS_PATH, 'utf8'), 'el corpus del frontend es el mismo');
  });

  const V = loadDist('modules/course-shell/v3-validation.js');
  await check('LQ3 validación server-side: regionalismo / voseo / «vosotros» → LANGUAGE_NOT_NEUTRAL (reintentable); limpio, idiomas, bibliografía, ids y URLs → sin error de idioma', () => {
    const lang = (doc) => V.v3LanguageErrors(JSON.stringify(doc)).map((e) => e.code);
    eq(lang({ title: 'Qué chévere este módulo' }), ['LANGUAGE_NOT_NEUTRAL'], 'regionalismo');
    eq(lang({ blocks: [{ text: 'Acá podés ver el proceso.' }] }), ['LANGUAGE_NOT_NEUTRAL'], 'voseo que llegó sin corregir');
    eq(lang({ intro: 'Vosotros debéis revisar el caso.' }), ['LANGUAGE_NOT_NEUTRAL'], 'vosotros');
    eq(lang({ title: 'Puedes revisar el proceso con calma.', id: 'tenés-podés', url: 'https://x.test/che,', bibliography: ['Pérez, J. (2019). El laburo en el Río de la Plata.'] }), [], 'limpio');
    const e = V.v3LanguageErrors(JSON.stringify({ a: { b: ['Enciende el ordenador.'] } }))[0];
    eq(e.path, '$.a.b[0]', 'ruta');
    assert(/regionalismo de España \(«ordenador»\)/.test(e.message), e.message);
    // GIFT (texto, no JSON): también se revisa.
    eq(V.v3LanguageErrors('::P1:: ¿Qué hacés primero? {=Revisar ~Esperar}').map((x) => x.code), ['LANGUAGE_NOT_NEUTRAL'], 'GIFT');
    // validateV3ItemArtifact agrega los errores de idioma al resultado de su tipo; curso de idiomas exento.
    const ctx = { type: 'course_intro', itemKey: 'course_intro:1' };
    const r = V.validateV3ItemArtifact(ctx, JSON.stringify({ title: 'Qué chévere' }));
    assert(!r.ok && r.errors.some((x) => x.code === 'LANGUAGE_NOT_NEUTRAL'), JSON.stringify(r.errors.map((x) => x.code)));
    const rl = V.validateV3ItemArtifact({ ...ctx, languageCourse: true }, JSON.stringify({ title: 'Qué chévere' }));
    assert(!rl.errors.some((x) => x.code === 'LANGUAGE_NOT_NEUTRAL'), 'curso de idiomas: sin chequeo de idioma');
  });

  await check('LQ4 capítulo (Markdown) en el scheduler: el idioma se valida con el lector de artifacts; curso de idiomas se detecta del contexto congelado', async () => {
    const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
    const s = Object.create(SchedulerService.prototype);
    const store = { 'art-1': '# Capítulo\n\nAcá revisás el laburo del día.\n\n## Bibliografía\nPérez, J. (2019). Guita y laburo. Editorial Andina.' };
    s.dataSource = { query: async (sql, params) => {
      if (/from public\.artifacts/.test(sql)) return [{ id: 'art-1', type: 'dynamic_content_md', storage_bucket: 'b', storage_path: 'p' }];
      if (/generation_run_contexts/.test(sql)) return [{ context: params[0] === 'job-lang' ? { nombre: 'Literatura rioplatense' } : { nombre: 'Seguridad industrial' } }];
      return [];
    } };
    s.v3Reader = { readText: async (a) => store[a.id] };
    const g = { id: 'ir-1', item_key: 'content:1', owner_id: 'o', frontend_course_id: 'c', job_course_id: 1, job_id: 'job-1' };
    const errs = await s.contentLanguageErrors(g, ['art-1']);
    eq([...new Set(errs.map((e) => e.code))], ['LANGUAGE_NOT_NEUTRAL'], 'regionalismo en el capítulo');
    assert(errs.some((e) => /«laburo»/.test(e.message)) && !errs.some((e) => /«guita»/.test(e.message)), 'la bibliografía no se revisa: ' + JSON.stringify(errs.map((e) => e.message)));
    eq(await s.isLanguageCourseRun('job-lang'), true, 'curso de literatura');
    eq(await s.isLanguageCourseRun('job-1'), false, 'curso técnico');
    store['art-1'] = '# Capítulo\n\nAquí revisas el trabajo del día.';
    eq(await s.contentLanguageErrors(g, ['art-1']), [], 'capítulo limpio');
  });

  await check('LQ5 audiolibro: regla neutra para cualquier país; voseo corregido antes de narrar; un regionalismo que queda → AUDIOBOOK_LANGUAGE_NOT_NEUTRAL (reintentable)', async () => {
    const A = loadDist('workers/provider-real/audio-scripts.js');
    for (const pais of ['Argentina', 'Uruguay', 'Paraguay', 'Colombia', 'España']) {
      const r = A.audioLocaleRule(pais);
      assert(/NEUTRO/.test(r) && /NUNCA voseo/.test(r) && !/trato habitual/.test(r), `${pais}: ${r}`);
    }
    eq(A.cleanNarrationText('**Acá** podés ver el proceso.'), 'Acá puedes ver el proceso.', 'voseo corregido');
    const words = (n) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ');
    const section = { idx: 0, title: 'Bloque', text: words(120), words: 120, sha256: 'x' };
    const input = { courseTitle: 'Curso', chapterNumber: 1, chapterTitle: 'Capítulo', pais: 'Argentina', contentMarkdown: words(120) };
    const say = (t) => async () => ({ text: t, messageId: 'm1' });
    const okText = 'Hoy revisas el proceso con calma y tú puedes aplicarlo. ' + words(105);
    const r = await A.generateSectionScript(input, section, 1, null, say(okText.replace('tú puedes', 'vos podés')));
    assert(/tú puedes aplicarlo/.test(r.text) && !/podés/.test(r.text), r.text.slice(0, 80));
    let err = null;
    try { await A.generateSectionScript(input, section, 1, null, say('Hoy revisas el laburo con calma. ' + words(110))); } catch (e) { err = e; }
    assert(err && err.code === 'AUDIOBOOK_LANGUAGE_NOT_NEUTRAL' && err.retryable === true, String(err && err.message));
  });

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
