#!/usr/bin/env node
/* eslint-disable no-console */
// T6 (r57) — acumulado del CURSO para la prueba de sesgo de respuesta (#542 / T1 §7) en la generación.
// USD 0: sin red, sin LLM, sin base (fakes en memoria; el ejecutor vendorizado corre en vm).
//
//   A1  answerBiasSignalsOf: acepta solo señales bien formadas (k conocido, m 2–12, r múltiplo de ½ en [0, m−1], tf
//       booleanos, topes); nunca adivina
//   A2  answerBiasPoolFrom: excluye el propio item, orden estable por itemKey, tope de items, null sin señales
//   A3  scheduler: el claim de video_interactions / activity h5p trae answerBiasPool de los items COMPLETADOS del run
//       (generación vigente, sin el propio item); sin señales → sin bloque; scorm / otros tipos → nunca consulta
//   A4  contrato ejecutor ↔ servidor: las señales que escribe el ejecutor VENDORIZADO (summary.answerBias.signals)
//       pasan answerBiasSignalsOf y, devueltas en el claim, hacen que un set chico sesgado pida el reintento que solo
//       no pediría (el patrón del curso ya no se escapa entre procesos)
//
// Uso: node scripts/check-t6-answer-bias-pool.js [dist]   (después de npm run build)
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const POOL = L('modules/quality/answer-bias-pool.js');
const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const sum = (signals) => ({ answerBias: { mc: 3, signals } });

(async () => {
  await check('A1 answerBiasSignalsOf: solo señales bien formadas', () => {
    const ok = { k: 'video_interactions', ranks: [{ m: 3, r: 2 }, { m: 4, r: 1.5 }], tf: [true, false] };
    eq(POOL.answerBiasSignalsOf(sum(ok)), ok, 'válidas');
    for (const bad of [
      { ...ok, k: 'exam' }, { ...ok, ranks: [{ m: 1, r: 0 }] }, { ...ok, ranks: [{ m: 3, r: 3 }] }, { ...ok, ranks: [{ m: 3, r: 0.3 }] },
      { ...ok, tf: ['sí'] }, { ...ok, ranks: Array.from({ length: 61 }, () => ({ m: 3, r: 0 })) }, { k: 'questionset', ranks: 'x', tf: [] },
    ]) eq(POOL.answerBiasSignalsOf(sum(bad)), null, `inválidas ${JSON.stringify(bad).slice(0, 60)}`);
    eq(POOL.answerBiasSignalsOf({}), null, 'summary sin answerBias');
    eq(POOL.answerBiasSignalsOf({ answerBias: { mc: 3 } }), null, 'summary viejo sin signals');
  });

  await check('A2 answerBiasPoolFrom: sin el propio item, orden estable, tope, null sin señales', () => {
    const s = (r) => sum({ k: 'video_interactions', ranks: [{ m: 3, r }], tf: [] });
    const rows = [{ itemKey: 'video_interactions:b', summary: s(2) }, { itemKey: 'video_interactions:a', summary: s(0) }, { itemKey: 'video_interactions:yo', summary: s(2) }, { itemKey: 'activity:x', summary: { answerBias: { mc: 2 } } }];
    const p = POOL.answerBiasPoolFrom(rows, 'video_interactions:yo');
    eq(Object.keys(p.items), ['video_interactions:a', 'video_interactions:b'], 'orden y exclusión');
    eq(p.v, 1, 'versión');
    eq(POOL.answerBiasPoolFrom([{ itemKey: 'video_interactions:yo', summary: s(2) }], 'video_interactions:yo'), null, 'solo el propio → null');
    eq(POOL.answerBiasPoolFrom([{ itemKey: 'activity:x', summary: sum({ k: 'questionset', ranks: [], tf: [] }) }], 'z'), null, 'señales vacías → null');
    const many = Array.from({ length: POOL.ANSWER_BIAS_POOL_MAX_ITEMS + 20 }, (_, i) => ({ itemKey: `video_interactions:${String(i).padStart(4, '0')}`, summary: s(1) }));
    eq(Object.keys(POOL.answerBiasPoolFrom(many, 'z').items).length, POOL.ANSWER_BIAS_POOL_MAX_ITEMS, 'tope');
  });

  await check('A3 scheduler: el claim de activity h5p trae el acumulado de los items completados del run; sin señales nada; scorm no consulta', async () => {
    const svc = Object.create(SchedulerService.prototype);
    const manifest = { rulesVersion: 3, modules: [], items: [] };
    const mItem = { key: 'activity:c1', type: 'activity', variant: 'h5p', chapterId: 'c1', h5pType: 'questionset' };
    const queries = [];
    const mk = (rows) => ({ async query(sql, params) { queries.push({ sql, params }); if (/output_summary -> 'answerBias'/.test(sql)) return rows; throw new Error(`SQL no esperado: ${sql.slice(0, 60)}`); } });
    const row = { type: 'activity', chapter_id: 'c1', job_id: 'job-1', manifest_id: 7, item_key: 'activity:c1' };
    const sig = { k: 'video_interactions', ranks: [{ m: 3, r: 2 }], tf: [false] };
    const claim = await svc.buildClaimV3(mk([{ item_key: 'video_interactions:c2', answer_bias: JSON.stringify({ mc: 1, signals: sig }) }, { item_key: 'activity:c3', answer_bias: { mc: 2 } }]), row, mItem, manifest);
    eq(claim.answerBiasPool, { v: 1, items: { 'video_interactions:c2': sig } }, 'pool en el claim');
    const q = queries[0];
    assert(/d\.status = 'completed'/.test(q.sql) && /d\.item_key <> \$4/.test(q.sql) && /latest|generation/.test(q.sql), `consulta: ${q.sql}`);
    eq([q.params[0], q.params[1], q.params[2], q.params[3]], ['job-1', 7, ['video_interactions', 'activity'], 'activity:c1'], 'parámetros');
    const none = await svc.buildClaimV3(mk([]), row, mItem, manifest);
    assert(!('answerBiasPool' in none), 'sin señales → sin bloque');
    queries.length = 0;
    await svc.buildClaimV3(mk([]), { ...row, item_key: 'activity:c1' }, { ...mItem, variant: 'scorm' }, manifest);
    eq(queries.length, 0, 'scorm: sin consulta');
    await svc.buildClaimV3(mk([]), { type: 'experience', chapter_id: 'c1', job_id: 'job-1', manifest_id: 7, item_key: 'experience:c1' }, { key: 'experience:c1', type: 'experience' }, manifest);
    eq(queries.length, 0, 'experience: sin consulta');
  });

  await check('A4 contrato ejecutor vendorizado ↔ servidor: señales del summary válidas; devueltas en el claim, el curso sesgado pide el reintento', async () => {
    const dir = path.join(__dirname, '..', 'vendor', 'dynamic-executor');
    const ctx = { console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON };
    ctx.window = ctx;
    ctx.fetch = global.fetch;
    vm.createContext(ctx);
    for (const f of ['05-libro.js', '07-examenes.js', '08-downloads.js', '44-dynamic-prompt-builders.js', '45-dynamic-generation-executor.js', '46-dynamic-context-package.js']) {
      vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
    }
    const X = (n) => 'x'.repeat(n);
    const mc = (c, ws) => ({ kind: 'multichoice', answers: [{ text: X(c), correct: true }].concat(ws.map((w) => ({ text: X(w), correct: false }))) });
    // Seis videos YA aceptados en OTROS procesos (runId distintos → acumulados locales vacíos), cada uno con su set.
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const t = ctx.dynAnswerBiasTest({ runId: `proc-${i}`, itemKey: `video_interactions:c${i}` }, 'video_interactions', { checkpoints: [mc(70, [40, 30]), mc(72, [41, 33]), mc(30, [40, 50]), mc(65, [40, 20])] });
      const signals = JSON.parse(JSON.stringify(t.stats.signals));
      assert(POOL.answerBiasSignalsOf({ answerBias: { signals } }), `señales del ejecutor aceptadas: ${JSON.stringify(signals)}`);
      rows.push({ itemKey: `video_interactions:c${i}`, summary: { answerBias: JSON.parse(JSON.stringify(t.stats)) } });
    }
    const own = { checkpoints: [mc(60, [40, 30]), mc(61, [40, 30]), mc(30, [40, 50])] };
    const solo = ctx.dynAnswerBiasTest({ runId: 'nuevo-1', itemKey: 'video_interactions:yo' }, 'video_interactions', own);
    eq(solo.errors.length, 0, 'solo (otro proceso, sin claim): no ve el patrón');
    const pool = POOL.answerBiasPoolFrom(rows, 'video_interactions:yo');
    const seeded = ctx.dynAnswerBiasTest({ runId: 'nuevo-2', itemKey: 'video_interactions:yo', claimPayload: { answerBiasPool: JSON.parse(JSON.stringify(pool)) } }, 'video_interactions', own);
    assert(seeded.errors.some((e) => /^\[ANSWER_LENGTH_BIAS\]/.test(e)), `con el claim pide el reintento: ${JSON.stringify(seeded.errors)}`);
    eq([seeded.stats.pooledItems, seeded.stats.course.mc, seeded.stats.course.correctLongest], [6, 27, 20], 'acumulado del curso');
  });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
