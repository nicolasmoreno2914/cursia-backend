#!/usr/bin/env node
/* eslint-disable */
// r107 B6 · Taller de cursos — APLICAR un plan aprobado: el núcleo PURO (`apply/apply-core.ts`) contra el código
// COMPILADO (dist/). USD 0: sin IA, sin red, sin base, sin disco. Fixtures sintéticos generados en el momento (el v3 A-S del
// motor de la simulación comercial y el V1 mínimo de B3/B4). Lo que necesita base (cola, reclamo / latido, 409 por la API,
// descarga, sesión hija, conciliación) corre en check-r107-workshop-service.js (PG16 local, W55–W66).
//
//   A1  plan → aplicar → versión lista: paquete nuevo (sha1/sha256), informe de cambios por ítem (antes/después, archivos,
//       ids), diagnóstico del resultado (resueltos, ningún nuevo), validador v3 sin problemas nuevos, original intacto
//   A2  V1 (línea anterior al v3): validación de estructura (lector seguro + T01–T03), mismo informe
//   A3  bytes que no son el original de la sesión → falla `verify_original`, sin paquete
//   A4  el motor rechaza un ítem (precondición vencida / destino inexistente) → falla `engine` con el ítem que falló, sin paquete
//   A5  la compuerta antes/después: un ítem que agrega un botón «href=#» → falla `gate` con el hallazgo nuevo, sin paquete
//   A6  validador: un resultado con problemas nuevos del validador v3 (FILES_INTEGRITY) → `introduced` con el código
//   A7  restauración: sin verificador → `not_available` con el texto EXACTO del ruling; con uno que pasa → `passed`; que
//       falla → falla `restore`; que se cae → falla reintentable — nunca «restaurado» sin hacerlo
//   A8  qué se aplica: quitados / retirados fuera; fase posterior informada aparte; sin generar / pedido no listo bloquean;
//       confirmaciones de riesgo alto que faltan y las que no corresponden
//   A9  cadena de versiones: número = padre + 1; cadena original → v1 → v2 (y corta ciclos); ruta determinista en la
//       carpeta del dueño; encadenar: aplicar sobre la versión 1 produce la 2 con su propio informe
//   A10 memoria/carril: factores medidos (zip 7×, tar.gz 10×); el tope de subida (200 MB) entra en el presupuesto por defecto
//   A11 el informe recorta un antes/después enorme con aviso (el paquete lleva el texto completo); mismo plan → mismos bytes
//   A13 (fix 1, P2-2) huella del contenido revisado: cambia con los parámetros o el antes/después; la del plan, con el
//       orden y cada ítem; approvalMismatch detecta cambiados / faltantes / sobrantes / huella del plan
//   A14 (fix 2, B7) filtro global de errores: los 4xx del Taller pasan SUS detalles (ids, bloqueos, estimado…) con su
//       forma; nada para otros códigos ni para 5xx; claves que parecen secretas fuera; tamaño acotado
//   A12 Libro v3 (PDF): con la entrada del builder SIN cambios se reproduce byte a byte el PDF del original; con el markdown
//       nuevo del capítulo → PDF nuevo (lo arma el builder, no la IA) → el motor lo reemplaza en el original (blob +
//       files.xml) y la versión pasa la compuerta y el validador; fuente que no reproduce / capítulo desconocido / sin
//       fuente en el servidor → `unavailable` con motivo; un PDF que no es PDF o vencido → el motor lo rechaza
//
// Uso: npm run build && node scripts/r107/check-r107-apply.js --ci [--dist dist]
'use strict';
require('reflect-metadata');
const path = require('path');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (!argv.includes('--ci')) { console.error('Uso: --ci [--dist dist]'); process.exit(2); }
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };
const realFetch = global.fetch;
global.fetch = async (u) => { throw new Error(`RED PROHIBIDA en el check: ${String(u)}`); };
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

let ok = 0; let fail = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha = (alg, b) => crypto.createHash(alg).update(b).digest('hex');

(async () => {
  const A = L('modules/course-workshop/apply/apply-core.js');
  const R = L('modules/course-workshop/mbz-reader.js');
  const I = L('modules/course-workshop/identify.js');
  const INV = L('modules/course-workshop/inventory.js');
  const SVC = L('modules/course-workshop/course-workshop.service.js');
  const FX = require(path.join(REPO, 'scripts/r107/lib/r107-fixtures.js'));
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const JSZip = require('jszip');
  global.fetch = realFetch; // la simulación no usa red; se vuelve a prohibir después
  const SIM = await S.simulateCourse(DIST, COURSES.find((c) => c.id === 'A-S'));
  const AS = SIM.built.mbz;
  const V1 = await FX.miniV1(await FX.audiobookOf(AS));
  global.fetch = async (u) => { throw new Error(`RED PROHIBIDA en el check: ${String(u)}`); };
  const inventoryOf = async (buf) => { const pkg = await R.openMbz(buf); const f = await I.readPackageFacts(pkg, 'x.mbz'); return INV.buildInventory(pkg, { family: I.familyOf(f), builderLine: I.builderLineOf(f) }); };
  const field = (inv, mid, f = 'intro') => inv.activities.find((a) => a.moduleId === mid).html.find((h) => h.field === f);
  const item = (id, params, extra = {}) => ({ id, requestId: `r-${id}`, operation: params.op, quote: `pedido ${id}`, summary: `ítem ${id}`, params, ...extra });
  const MC = (t) => ({ qtype: 'multichoice', text: `<p>${t}</p>`, answers: [{ html: 'Opción correcta', fraction: 1 }, { html: 'Opción distractora uno', fraction: 0 }, { html: 'Opción distractora dos', fraction: 0 }, { html: 'Opción distractora tres', fraction: 0 }] });
  const invAS = await inventoryOf(AS);
  const welcome = field(invAS, 1000);
  const appended = welcome.html.replace(/<\/div>\s*$/, () => '<p style="color:#20261E">Actualizado por el Taller en 2026 («ñ», $&amp;, O\'Brien).</p></div>');
  const quiz = invAS.activities.find((a) => a.modname === 'quiz' && a.exam && a.exam.questions.some((q) => q.qtype === 'multichoice'));
  const q0 = quiz.exam.questions.find((q) => q.qtype === 'multichoice');
  const opsAS = [
    { op: 'edit_html', target: { moduleId: 1000, field: 'intro' }, expectRawSha1: welcome.rawSha1, change: { kind: 'replace', html: appended } },
    { op: 'exam_question_replace', quizModuleId: quiz.moduleId, questionId: q0.id, question: MC('¿Cuál es la respuesta revisada por el Taller?') },
    { op: 'brand_replace', colors: { '#B45309': '#0F766E' } },
  ];
  let v1Result = null;

  await check('A1 plan → aplicar → versión lista: paquete nuevo, informe por ítem (antes/después, archivos, ids), diagnóstico sin nuevos, validador v3 sin nuevos, original intacto', async () => {
    const before = sha('sha1', AS);
    const stages = [];
    const res = await A.runApply({ original: AS, expectedSha1: before, filename: 'curso.mbz', items: opsAS.map((p, i) => item(`i${i}`, p)), onStage: (s) => { stages.push(s); } });
    assert(res.ok, `debió aplicarse: ${JSON.stringify(res).slice(0, 400)}`);
    eq(sha('sha1', AS), before, 'el original NO cambia');
    eq([res.sha1, res.sha256, res.size], [sha('sha1', res.package), sha('sha256', res.package), res.package.length], 'huellas del paquete nuevo');
    assert(res.sha1 !== before, 'el paquete es otro');
    eq(stages, ['verifying'], 'pasó a verificar después del motor');
    eq(res.items.map((x) => [x.itemId, x.operation]), [['i0', 'edit_html'], ['i1', 'exam_question_replace'], ['i2', 'brand_replace']], 'un informe por ítem, en orden');
    const f0 = res.items[0].fields[0];
    assert(f0.before === welcome.html && f0.after === appended && !f0.truncated, 'antes / después reales del campo');
    assert(res.items[1].fields.length >= 1 && Object.keys(res.items[1].idsAssigned).length >= 0, 'pregunta: campos');
    assert(res.items[2].fields.length >= 1, 'colores: campos cambiados');
    eq(res.diagnosis.introduced, [], 'ningún hallazgo nuevo');
    eq([res.validation.mode, res.validation.introduced], ['v3_structure', []], 'validador v3 sin problemas nuevos');
    assert(res.validation.before && res.validation.after, 'conteos del validador antes / después');
    const pkg = await R.openMbz(res.package);
    assert(pkg.container === 'zip' && pkg.has('moodle_backup.xml'), 'el paquete nuevo abre con el lector seguro');
    const inv2 = await inventoryOf(res.package);
    // El color del plan (ítem 3) también pasa por este campo: el resultado = el «después» del ítem 1 con el color nuevo.
    eq(field(inv2, 1000).html, res.items[2].fields.find((x) => x.moduleId === 1000).after, 'el campo quedó con el después de la última operación que lo tocó');
    assert(field(inv2, 1000).html.includes("Actualizado por el Taller en 2026 («ñ», $&amp;, O'Brien)."), 'el texto nuevo (con $& y apóstrofe tal cual)');
  });

  await check('A2 V1 (línea anterior al v3): validación de estructura (lector seguro + T01–T03) y el mismo informe', async () => {
    const inv = await inventoryOf(V1);
    const f = field(inv, 901);
    const html = `${f.html}<p>Nota del Taller: «Pingüino» & O'Brien.</p>`;
    const res = await A.runApply({ original: V1, expectedSha1: sha('sha1', V1), items: [item('v', { op: 'edit_html', target: { moduleId: 901, field: 'intro' }, expectRawSha1: f.rawSha1, change: { kind: 'replace', html } }), item('q', { op: 'exam_question_add', quizModuleId: 930, question: MC('¿2 × 3?') })] });
    assert(res.ok, JSON.stringify(res).slice(0, 300));
    eq([res.validation.mode, res.validation.introduced.length], ['structure', 0], 'estructura');
    assert(/T01–T03/.test(res.validation.note), 'dice qué se verificó');
    assert(Object.keys(res.items[1].idsAssigned).length > 0, 'ids nuevos de la pregunta en el informe');
    v1Result = res;
  });

  await check('A3 bytes que no son el original de la sesión → falla verify_original (sin paquete)', async () => {
    const res = await A.runApply({ original: V1, expectedSha1: sha('sha1', AS), items: [item('x', opsAS[2])] });
    eq([res.ok, res.stage, res.code, res.retryable], [false, 'verify_original', 'WORKSHOP_ORIGINAL_CHANGED', false], 'falla');
    assert(!('package' in res), 'sin paquete');
  });

  await check('A4 el motor rechaza un ítem → falla `engine` con el ítem que falló (todo o nada, sin paquete)', async () => {
    const bad = { op: 'edit_html', target: { moduleId: 1000, field: 'intro' }, expectRawSha1: '0'.repeat(40), change: { kind: 'replace', html: '<p>x</p>' } };
    const res = await A.runApply({ original: AS, expectedSha1: sha('sha1', AS), items: [item('a', opsAS[2]), item('b', bad)] });
    eq([res.ok, res.stage, res.failedItemId], [false, 'engine', 'b'], 'falla en el ítem b');
    assert(/^WORKSHOP_APPLY_/.test(res.code) && /ítem «ítem b»/.test(res.message), `código y motivo: ${res.code} ${res.message}`);
    const r2 = await A.runApply({ original: AS, expectedSha1: sha('sha1', AS), items: [item('c', { op: 'remove_activity', moduleId: 999999 })] });
    eq([r2.ok, r2.stage, r2.failedItemId], [false, 'engine', 'c'], 'destino inexistente');
  });

  await check('A5 compuerta antes/después: un ítem que agrega un botón «href=#» → falla `gate` con el hallazgo nuevo (sin paquete)', async () => {
    const inv = await inventoryOf(V1);
    const f = field(inv, 901);
    const res = await A.runApply({ original: V1, expectedSha1: sha('sha1', V1), items: [item('g', { op: 'edit_html', target: { moduleId: 901, field: 'intro' }, expectRawSha1: f.rawSha1, change: { kind: 'replace', html: '<p>Bienvenidos. <a href="#">Ir</a></p>' } })] });
    eq([res.ok, res.stage, res.code], [false, 'gate', 'WORKSHOP_APPLY_NEW_FINDINGS'], 'compuerta');
    assert(res.diagnosis && res.diagnosis.introduced.some((x) => /dead_link/.test(x.signature)), 'dice cuál');
    assert(/problemas nuevos/.test(res.message), res.message);
  });

  await check('A6 validador v3: un paquete con un archivo sin su blob (FILES_INTEGRITY) frente al original sano → problema nuevo con su código', async () => {
    const z = await JSZip.loadAsync(AS);
    const blob = Object.keys(z.files).find((n) => /^files\/[0-9a-f]{2}\/[0-9a-f]{40}$/.test(n));
    z.remove(blob);
    const broken = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const v = await A.validateResult(AS, broken, 'v3');
    assert(v.introduced.some((x) => x.code === 'FILES_INTEGRITY' && x.after > x.before), `FILES_INTEGRITY nuevo: ${JSON.stringify(v.introduced)}`);
    const same = await A.validateResult(AS, AS, 'v3');
    eq(same.introduced, [], 'el mismo paquete no tiene nada nuevo');
  });

  await check('A7 restauración: sin verificador → not_available con el texto EXACTO; verificador que pasa → passed; que falla → falla; que se cae → reintentable', async () => {
    eq(A.RESTORE_NOT_AVAILABLE_MESSAGE, 'Verificado en su estructura; la prueba de restauración en Moodle todavía no está disponible en este entorno', 'texto del ruling');
    eq([v1Result.restoreCheck.status, v1Result.restoreCheck.message, v1Result.restoreCheck.checker], ['not_available', A.RESTORE_NOT_AVAILABLE_MESSAGE, null], 'sin Moodle');
    assert(!/restaurad[oa]/i.test(v1Result.restoreCheck.message.replace(/restauración/g, '')), 'nunca dice «restaurado»');
    const base = { original: AS, expectedSha1: sha('sha1', AS), items: [item('c', opsAS[2])] };
    const seen = [];
    const pass = await A.runApply({ ...base, restoreChecker: { name: 'moodle-test', async check(pkg, meta) { seen.push(meta.sha1 === sha('sha1', pkg)); return { status: 'passed', message: 'restaurado en Moodle 4.5 sin errores' }; } } });
    eq([pass.ok, pass.restoreCheck.status, pass.restoreCheck.checker, seen], [true, 'passed', 'moodle-test', [true]], 'passed solo con el verificador');
    const no = await A.runApply({ ...base, restoreChecker: { name: 'm', async check() { return { status: 'failed', message: 'error de restauración: contextid' }; } } });
    eq([no.ok, no.stage, no.code, no.retryable], [false, 'restore', 'WORKSHOP_APPLY_RESTORE_FAILED', false], 'falla la restauración');
    const down = await A.runApply({ ...base, restoreChecker: { name: 'm', async check() { throw new Error('Moodle no responde'); } } });
    eq([down.ok, down.stage, down.retryable], [false, 'restore', true], 'verificador caído → reintentable');
  });

  await check('A8 qué se aplica: quitados/retirados fuera, fase posterior aparte, sin generar / pedido no listo bloquean; confirmaciones de riesgo alto', async () => {
    const c = (id, o = {}) => ({ id, requestId: `r${id}`, operation: 'edit_html', status: 'proposed', requestStatus: 'resolved', stage: 'ready', available: true, params: { op: 'edit_html' }, requiresItemConfirm: false, summary: id, quote: id, riskLevel: 'bajo', ...o });
    const sel = A.selectApplyItems([c('a'), c('b', { status: 'removed' }), c('c', { requestStatus: 'withdrawn' }), c('d', { available: false, operation: 'regenerate_scorm', params: null }), c('e', { stage: 'estimate' }), c('f', { requestStatus: 'preparing' }), c('g', { requiresItemConfirm: true, riskLevel: 'alto', operation: 'remove_activity' })]);
    eq([sel.apply.map((x) => x.id), sel.later.map((x) => x.id), sel.blocking.map((x) => x.itemId)], [['a', 'g'], ['d'], ['e', 'f']], 'selección');
    assert(/generó su contenido/.test(sel.blocking[0].reason), 'motivo visible');
    eq(A.confirmationsMissing(sel.apply, []), { missing: ['g'], unknown: [] }, 'falta confirmar g');
    eq(A.confirmationsMissing(sel.apply, ['G', 'zz']), { missing: [], unknown: ['zz'] }, 'confirmado (sin importar mayúsculas) + uno que no corresponde');
    eq(A.selectApplyItems([c('x', { params: null })]).blocking.length, 1, 'sin operación resuelta bloquea');
  });

  await check('A9 cadena de versiones: número = padre + 1, cadena original → v1 → v2 (sin ciclos), ruta determinista; aplicar sobre la versión 1 produce la 2', async () => {
    eq([A.nextVersionNumber(null), A.nextVersionNumber({ number: 1 }), A.nextVersionNumber({ number: 4 })], [1, 2, 5], 'números');
    const links = new Map([['v1', { versionId: 'v1', sessionId: 's1', number: 1, parentVersionId: null }], ['v2', { versionId: 'v2', sessionId: 's2', number: 2, parentVersionId: 'v1' }], ['v3', { versionId: 'v3', sessionId: 's3', number: 3, parentVersionId: 'v2' }]]);
    eq(A.chainOf(links.get('v3'), links).map((x) => x.versionId), ['v1', 'v2', 'v3'], 'cadena');
    links.set('v1', { ...links.get('v1'), parentVersionId: 'v3' });
    eq(A.chainOf(links.get('v3'), links).length, 3, 'un ciclo se corta');
    const p = A.versionStoragePath('AAAAAAAA-1111-4222-8333-444444444444', 'BBBBBBBB-1111-4222-8333-444444444444', 2, 'f'.repeat(40));
    eq(p, 'aaaaaaaa-1111-4222-8333-444444444444/workshop/bbbbbbbb-1111-4222-8333-444444444444/versions/v2-ffffffffffff.mbz', 'ruta en la carpeta del dueño');
    // Encadenar de verdad: la versión 1 (A2) como original de una sesión hija → otro arreglo → versión 2.
    const v1 = v1Result.package;
    const inv = await inventoryOf(v1);
    const f = field(inv, 901);
    const res2 = await A.runApply({ original: v1, expectedSha1: v1Result.sha1, items: [item('w', { op: 'edit_html', target: { moduleId: 901, field: 'intro' }, expectRawSha1: f.rawSha1, change: { kind: 'replace', html: `${f.html}<p>Segunda corrección.</p>` } })] });
    assert(res2.ok && res2.sha1 !== v1Result.sha1 && res2.sha1 !== sha('sha1', V1), 'versión 2 distinta de la 1 y del original');
    eq(res2.items[0].fields[0].before, f.html, 'el «antes» de la 2 es el «después» de la 1');
  });

  await check('A10 memoria y carril: factores medidos (zip 7×, tar.gz 10×), el tope de subida (200 MB) entra en el presupuesto por defecto', async () => {
    eq([A.applyMemoryFactor('zip'), A.applyMemoryFactor('tar.gz'), A.applyMemoryFactor(null)], [7, 10, 7], 'factores');
    const budget = SVC.workshopMemoryBudgetBytes({});
    assert(200 * 1024 * 1024 * A.APPLY_MEMORY_FACTOR_TGZ <= budget, `200 MB tar.gz × 10 = ${200 * 10} MB ≤ presupuesto ${budget / 1048576} MB`);
    assert(A.APPLY_MEMORY_FACTOR_ZIP >= SVC.DIAGNOSIS_MEMORY_FACTOR && A.APPLY_MEMORY_FACTOR_TGZ >= SVC.DIAGNOSIS_MEMORY_FACTOR_TGZ, 'aplicar nunca reserva menos que un diagnóstico');
  });

  await check('A11 el informe recorta un antes/después enorme con aviso (el paquete lleva el texto completo); mismo plan → mismos bytes', async () => {
    const big = 'x'.repeat(A.REPORT_FIELD_MAX_CHARS + 50);
    const rep = A.itemReports([{ id: 'i', requestId: 'r', operation: 'edit_html', quote: 'q', summary: 's' }], [{ index: 0, op: 'edit_html', summary: 'S', fields: [{ entry: 'e', field: 'intro', moduleId: 1, sectionId: null, before: big, after: 'y', beforeRawSha1: 'a', afterRawSha1: 'b' }], files: [], entriesAdded: [], entriesRemoved: [], entriesModified: ['e'], idsAssigned: {}, misalignment: [], notes: [] }]);
    eq([rep[0].fields[0].truncated, rep[0].fields[0].before.length > A.REPORT_FIELD_MAX_CHARS, /recortado en el informe/.test(rep[0].fields[0].before), rep[0].summary], [true, true, true, 'S'], 'recorte visible');
    const base = { original: AS, expectedSha1: sha('sha1', AS), items: opsAS.map((p, i) => item(`i${i}`, p)) };
    const x = await A.runApply(base);
    const y = await A.runApply(base);
    assert(x.ok && y.ok && x.sha1 === y.sha1, 'determinista');
  });

  await check('A12 Libro v3 (PDF): el builder reproduce el PDF del original con la fuente sin cambios; con el capítulo nuevo → PDF nuevo → el motor lo reemplaza y la versión pasa compuerta + validador; fuente que no reproduce / capítulo desconocido / sin fuente → unavailable', async () => {
    const LV = L('modules/course-workshop/apply/libro-v3.js');
    const PP = L('modules/dynamic-packaging/packaging-plan-v3.js');
    const B = L('package/dynamic-mbz-builder-v3.js');
    const input = SIM.input;
    const plan = PP.buildPackagingPlanV3(input.manifest, input.blueprint, { manifestId: input.manifestId ?? null, omitVideoChapterIds: input.pendingVideoChapterIds ?? [] });
    const byNum = new Map(plan.modules.flatMap((m) => m.chapters.filter((c) => c.kind !== 'practice').map((c) => [c.chapterNumber, c.chapterId])));
    const src = { buildInput: input, chapterIdByNumber: byNum };
    const cur = await LV.libroPdfOf(AS);
    assert(cur && cur.bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'el original trae el Libro en PDF');
    const md0 = input.contents.contentMd.get(byNum.get(1));
    let builds = 0;
    const build = (i) => { builds++; return B.buildDynamicMbzV3(i); };
    const regen = await LV.regenerateLibroV3Pdf(AS, src, [{ number: 1, md: `${md0}\n\nPárrafo agregado por el Taller en 2026: «ñ», O'Brien.` }], build);
    assert(regen.ok, JSON.stringify(regen).slice(0, 300));
    eq([regen.previousSha1, builds], [cur.sha1, 2], 'reprodujo el original (1.er armado) y armó el nuevo (2.º)');
    assert(regen.sha1 !== cur.sha1, 'el PDF cambió');
    const op = { op: 'edit_libro_section', moduleId: regen.moduleId, chapters: [{ number: 1, html: '' }], pdf: { base64: regen.pdf.toString('base64'), previousSha1: regen.previousSha1 } };
    const res = await A.runApply({ original: AS, expectedSha1: sha('sha1', AS), items: [item('lib', op)] });
    assert(res.ok, JSON.stringify(res).slice(0, 400));
    const after = await LV.libroPdfOf(res.package);
    eq([after.sha1, res.diagnosis.introduced, res.validation.introduced], [regen.sha1, [], []], 'el paquete nuevo lleva el PDF nuevo; sin hallazgos ni problemas nuevos');
    assert(res.items[0].misalignment.some((m) => /mod_book/.test(m)), 'avisa que el Libro en línea no cambió (D7)');
    // Fuente que NO reproduce el original (otra portada / otro título) → no se regenera.
    const other = { ...src, buildInput: { ...input, manifest: { ...input.manifest, course: { ...(input.manifest.course || {}), title: 'Otro título' } } } };
    const nr = await LV.regenerateLibroV3Pdf(AS, other, [{ number: 1, md: 'x' }], build).catch((e) => ({ ok: false, code: 'build_failed', reason: e.message }));
    assert(!nr.ok && ['not_reproducible', 'build_failed'].includes(nr.code), `no reproduce: ${JSON.stringify(nr).slice(0, 200)}`);
    eq((await LV.regenerateLibroV3Pdf(AS, src, [{ number: 99, md: 'x' }], build)).code, 'chapter_unknown', 'capítulo desconocido');
    eq((await LV.regenerateLibroV3Pdf(V1, src, [{ number: 1, md: 'x' }], build)).code, 'no_pdf', 'V1: no es PDF');
    const none = await LV.SERVER_LIBRO_V3_RESOLVER.resolve({ id: 's', ownerId: 'o', institutionId: null, identifiedCourseId: 1 });
    assert('unavailable' in none && /todavía no se puede regenerar/.test(none.unavailable), 'el servidor dice por qué no (todavía)');
    // El motor rechaza un PDF que no es PDF o uno regenerado sobre otro original.
    const bad = await A.runApply({ original: AS, expectedSha1: sha('sha1', AS), items: [item('b', { ...op, pdf: { base64: Buffer.from('hola').toString('base64'), previousSha1: cur.sha1 } })] });
    eq([bad.ok, bad.stage, bad.code], [false, 'engine', 'WORKSHOP_APPLY_INVALID_CONTENT'], 'no es PDF');
    const stale = await A.runApply({ original: AS, expectedSha1: sha('sha1', AS), items: [item('s', { ...op, pdf: { ...op.pdf, previousSha1: '0'.repeat(40) } })] });
    eq([stale.ok, stale.code], [false, 'WORKSHOP_APPLY_STALE_TARGET'], 'vencido');
  });

  await check('A13 (fix 1, P2-2) huella del contenido revisado: parámetros y antes/después cambian la huella; la del plan depende de orden e ítems; approvalMismatch', async () => {
    const base = { operation: 'edit_html', stage: 'ready', params: { op: 'edit_html', target: { moduleId: 1, field: 'intro' }, change: { kind: 'replace', html: '<p>a</p>' } }, view: { changes: [{ before: 'x', after: '<p>a</p>' }], files: [], entries: { added: [], removed: [], modified: [] }, cost: { x: 1 } } };
    const h = A.itemContentHash(base);
    assert(/^[0-9a-f]{64}$/.test(h), 'sha256');
    eq(A.itemContentHash(JSON.parse(JSON.stringify(base))), h, 'estable');
    eq(A.itemContentHash({ ...base, view: { ...base.view, cost: { x: 2 } } }), h, 'lo que no es contenido (costo) no cuenta');
    assert(A.itemContentHash({ ...base, params: { ...base.params, change: { kind: 'replace', html: '<p>b</p>' } } }) !== h, 'otro HTML → otra huella');
    assert(A.itemContentHash({ ...base, view: { ...base.view, changes: [{ before: 'x', after: '<p>b</p>' }] } }) !== h, 'otro después → otra huella');
    assert(A.itemContentHash({ ...base, params: { op: 'remove_activity', moduleId: 2 }, operation: 'remove_activity' }) !== A.itemContentHash({ ...base, params: { op: 'remove_activity', moduleId: 3 }, operation: 'remove_activity' }), 'quitar otra actividad → otra huella');
    const items = [{ id: 'A1A1A1A1-1111-4111-8111-111111111111', contentHash: h }, { id: 'b2b2b2b2-2222-4222-8222-222222222222', contentHash: 'c'.repeat(64) }];
    const ph = A.planContentHash(items);
    assert(ph !== A.planContentHash([...items].reverse()), 'el orden cuenta');
    const cur = items.map((x) => ({ ...x, id: x.id.toLowerCase() }));
    eq(A.approvalMismatch(cur, { planHash: ph, items, confirm: [] }), { changed: [], missing: [], extra: [], planHashOk: true }, 'igual');
    eq(A.approvalMismatch(cur, { planHash: ph, items: [{ ...items[0], contentHash: 'd'.repeat(64) }, { id: 'e5e5e5e5-5555-4555-8555-555555555555', contentHash: h }], confirm: [] }), { changed: [cur[0].id], missing: [cur[1].id], extra: ['e5e5e5e5-5555-4555-8555-555555555555'], planHashOk: true }, 'cambiado / faltante / sobrante');
    eq(A.approvalMismatch(cur, { planHash: 'f'.repeat(64), items, confirm: [] }).planHashOk, false, 'huella del plan');
  });

  await check('A14 (fix 2, B7) AllExceptionsFilter: un 409 del Taller llega con sus detalles (changedItemIds, blocking, failedItemId, estimate, version…); otro código o un 5xx no; secretos y formas inválidas fuera', async () => {
    const FL = L('common/filters/http-exception.filter.js');
    const { ConflictException, BadRequestException, InternalServerErrorException } = require('@nestjs/common');
    const run = (exc) => { let out = null; const res = { status() { return this; }, json(b) { out = b; } }; new FL.AllExceptionsFilter().catch(exc, { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: '/x', method: 'POST' }) }) }); return out; };
    const id1 = '11111111-2222-4333-8444-555555555555';
    const b = run(new ConflictException({ code: 'WORKSHOP_APPLY_PLAN_CHANGED', message: 'cambió', changedItemIds: [id1], missingItemIds: ['no-uuid'], planHash: 'a'.repeat(64), items: [{ id: id1, contentHash: 'b'.repeat(64), apiKey: 'sk-secreto' }], blocking: [{ itemId: id1, reason: 'sin generar' }], estimate: { expectedUsd: '0.10', proposedCapUsd: '0.15' }, failedItemId: id1, version: { id: id1, status: 'failed', signedUrl: 'https://x' }, internal: { password: 'x' }, stack: 'Error at…' }));
    eq([b.code, b.error, b.changedItemIds, b.planHash, b.failedItemId, b.estimate.expectedUsd, b.blocking[0].reason], ['WORKSHOP_APPLY_PLAN_CHANGED', 'cambió', [id1], 'a'.repeat(64), id1, '0.10', 'sin generar'], 'detalles del Taller');
    eq([b.missingItemIds, b.items[0].apiKey, b.version.signedUrl, b.internal, b.stack], [undefined, undefined, undefined, undefined, undefined], 'forma inválida, secretos y claves no listadas: fuera');
    const o = run(new ConflictException({ code: 'OTRA_COSA', message: 'x', changedItemIds: [id1], blocking: [1], estimate: { a: 1 } }));
    eq([o.changedItemIds, o.blocking, o.estimate], [undefined, undefined, undefined], 'otro código: nada nuevo');
    const f = run(new InternalServerErrorException({ code: 'WORKSHOP_APPLY_FAILED', message: 'x', blocking: [{ a: 1 }] }));
    eq(f.blocking, undefined, '5xx: nada');
    const big = run(new BadRequestException({ code: 'WORKSHOP_X', message: 'x', items: Array.from({ length: 200 }, () => ({ t: 'y'.repeat(4000) })) }));
    eq(big.items, undefined, 'más de 64 KB: fuera');
    eq(FL.workshopErrorDetails({ code: 'WORKSHOP_A', status: 'applying' }), { status: 'applying' }, 'texto corto');
  });

  console.log(`\n${fail ? '❌' : '✅'} check-r107-apply --ci: ${ok}/${ok + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
