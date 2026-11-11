#!/usr/bin/env node
/* eslint-disable */
// r107 B11 · Taller de cursos — Fase 4: `add_chapter` / `add_module`. USD 0: TODOS los proveedores simulados
// (r107-regen-sim); cualquier salida real hace fallar el check.
//
// Fixtures: V1 armado con el BUILDER REAL (`MbzBuilderService.buildMbz`) con el patrón completo por capítulo (Gamma →
// texto → hvp → CTA → SCORM) y su variante vieja (sin hvp ni Gamma); el V1 mínimo de B3/B4 y el v3 A-S del motor de la
// simulación comercial (agregar capítulos en v3 queda NO DISPONIBLE con motivo).
//
// Uso: npm run build && node scripts/r107/check-r107-add-chapter.js --ci [--dist dist]
//      node scripts/r107/check-r107-add-chapter.js --bite   (cada mordida tiene que hacer fallar --ci)
'use strict';
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));

if (process.argv.includes('--bite')) {
  const FILE = 'modules/course-workshop/patch/op-add-chapter.js';
  const bites = [
    { name: 'id repetido (el moduleid nuevo = el del molde)', from: "mid: alloc.take('moduleid')", to: 'mid: activity.moduleId' },
    { name: 'numeración sin recalcular', from: 'await renumberChapters(ctx, texts, P, pl);', to: ';' },
    { name: 'blob sin entrada en files.xml', from: 'newFileBlocks.push(`<file id="${fid}">${body}</file>`);', to: 'if (!repl) newFileBlocks.push(`<file id="${fid}">${body}</file>`);' },
    { name: 'token huérfano (sin reescribir al capítulo nuevo)', from: "(midOf.has(Number(id)) ? `$@${k}*${midOf.get(Number(id))}@$` : m)", to: '(m)' },
    // Ronda de correcciones 1: cada arreglo tiene su mordida.
    { name: 'sin la prueba en seco del motor antes de pagar (P1-1)', file: 'modules/course-workshop/plan/chapter-item.js', from: 'const fail = await engineDryRun(ctx, plan);', to: 'const fail = null;' },
    { name: 'estructurales sin ir al final (P1-2 a)', file: 'modules/course-workshop/apply/apply-core.js', from: 'const items = structuralLast(input.items);', to: 'const items = input.items;' },
    { name: 'bloque del video sin resolver (P1-5)', from: 'const rewrite = (html) => slots(html)', to: 'const rewrite = (html) => (html)' },
  ];
  const tmp = fs.mkdtempSync(path.join(REPO, '.r107-bite-'));
  let code = 0;
  try {
    for (const b of bites) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, b.file || FILE);
      const src = fs.readFileSync(f, 'utf8');
      // tsc reescribe las comillas: la mordida se busca tal cual o con comillas dobles.
      const from = src.includes(b.from) ? b.from : b.from.replace(/'/g, '"');
      if (!src.includes(from)) { console.log(`❌ mordida «${b.name}»: no encontré el código`); code = 1; continue; }
      fs.writeFileSync(f, src.split(from).join(b.to));
      const r = spawnSync(process.execPath, [__filename, '--ci', '--dist', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const bit = r.status !== 0 && /❌/.test(r.stdout || '');
      console.log(bit ? `✅ mordida «${b.name}»: el check FALLA (${((r.stdout || '').match(/❌ [^\n]*/g) || []).slice(0, 2).join(' · ').slice(0, 220)})` : `❌ mordida «${b.name}»: NO hizo fallar el check`);
      if (!bit) code = 1;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

const SIMLIB = require(path.join(REPO, 'scripts/r107/lib/r107-regen-sim.js'));
const REAL = SIMLIB.blockNetwork('r107 B11 check');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

let ok = 0; let fail = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };
const unesc = (s) => String(s).split('&quot;').join('"').split('&gt;').join('>').split('&lt;').join('<').split('&amp;').join('&');

(async () => {
  const B = L('modules/course-workshop/plan/builder.js');
  const CI = L('modules/course-workshop/plan/chapter-item.js');
  const SVC = L('modules/course-workshop/plan/workshop-plan.service.js');
  const PL = L('modules/course-workshop/plan/index.js');
  const ENG = L('modules/course-workshop/patch/engine.js');
  const OPS = L('modules/course-workshop/patch/op-add-chapter.js');
  const A = L('modules/course-workshop/apply/apply-core.js');
  const BU = L('modules/course-workshop/regenerate/bundle.js');
  const R = L('modules/course-workshop/mbz-reader.js');
  const I = L('modules/course-workshop/identify.js');
  const INV = L('modules/course-workshop/inventory.js');
  const DRY = L('modules/pedagogy/dry-run.js');
  const FX = require(path.join(REPO, 'scripts/r107/lib/r107-fixtures.js'));
  const CF = require(path.join(REPO, 'scripts/r107/lib/r107-chapter-fixtures.js'));
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const JSZip = require('jszip');
  const PRICING = DRY.seedPricing();

  const V1 = await CF.v1BuilderCourse(DIST, {});
  const V1old = await CF.v1BuilderCourse(DIST, { hvp: false, gamma: false, audiobook: false });
  const ctxOf = async (buf) => { const ctx = await B.openBuildCtx(buf, { originalSha1: sha1(buf), pricing: PRICING }); ctx.ttsModel = 'gpt-4o-mini-tts-2025-03-20'; return ctx; };
  const inventoryOf = async (buf) => { const pkg = await R.openMbz(buf); const f = await I.readPackageFacts(pkg, 'x.mbz'); return INV.buildInventory(pkg, { family: I.familyOf(f), builderLine: I.builderLineOf(f) }); };
  const addReq = (ctx, o) => {
    const M = o.module;
    const mod = ctx.course.modules.find((m) => m.number === M);
    return { quote: o.quote || `Agrega un capítulo «${o.title}» en el módulo ${M}.`, instruction: o.quote || 'Agregar capítulo', operation: 'add_chapter', status: 'resolved', target: { kind: 'module', moduleNumber: M, title: `Módulo ${M}${mod && mod.title ? `: ${mod.title}` : ''}` }, rawTarget: null, details: { chapters: 1, newChapters: [{ title: o.title, objective: o.objective || null }], position: o.position ?? null, omit: o.omit || [] }, questions: [], reason: null };
  };
  const modReq = (o) => ({ quote: `Agrega el módulo «${o.title}».`, instruction: 'Agregar módulo', operation: 'add_module', status: 'resolved', target: { kind: 'course', title: `Módulo nuevo: ${o.title}` }, rawTarget: null, details: { chapters: o.chapters.length, newChapters: o.chapters.map((t) => ({ title: t, objective: null })), moduleTitle: o.title, omit: o.omit || [] }, questions: [], reason: null });
  /** Producción simulada por la compuerta en memoria (misma regla que el servicio). */
  const produce = async (buf, req, o = {}) => {
    const ctx = await ctxOf(buf);
    const prov = SIMLIB.simProviders(DIST, o.sim || {});
    const gate = SIMLIB.memGate(DIST, { capUsd: o.capUsd ?? 50 });
    const prep = await B.prepareRegenItem(ctx, req, { providers: prov, gate, spent: () => gate.spent(), ext: o.ext });
    return { ctx, prov, gate, prep };
  };
  /** Invariantes del paquete: ids únicos, files.xml ↔ blobs, tokens válidos (el saneador no cambia nada), numeración. */
  const invariants = async (buf, expect = {}) => {
    const z = await JSZip.loadAsync(buf);
    const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
    const txt = async (n) => z.file(n).async('string');
    const mb = await txt('moodle_backup.xml');
    const acts = [...mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>(\w+)<\/modulename>\s*<title>([\s\S]*?)<\/title>\s*<directory>([^<]*)<\/directory>/g)].map((m) => ({ mid: Number(m[1]), sec: Number(m[2]), mod: m[3], title: unesc(m[4]), dir: m[5] }));
    const dup = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i);
    eq(dup(acts.map((a) => a.mid)), [], 'moduleid repetido en moodle_backup.xml');
    const ctxIds = []; const modIds = []; const scoIds = [];
    for (const a of acts) {
      assert(z.file(`${a.dir}/module.xml`), `falta ${a.dir}/module.xml`);
      const mx = await txt(`${a.dir}/module.xml`);
      eq(Number(/<module id="(\d+)"/.exec(mx)[1]), a.mid, `${a.dir}: module id`);
      modIds.push(a.mid);
      const main = await txt(`${a.dir}/${a.mod}.xml`);
      ctxIds.push(Number(/contextid="(\d+)"/.exec(main)[1]));
      for (const m of main.matchAll(/<(?:sco|sco_data)\s+id="(\d+)"/g)) scoIds.push(Number(m[1]));
      // ningún id de otra actividad (atributos)
      eq(Number(/moduleid="(\d+)"/.exec(main)[1]), a.mid, `${a.dir}: moduleid del XML`);
    }
    eq(dup(ctxIds), [], 'contextid repetido');
    eq(dup(scoIds), [], 'sco / sco_data repetido');
    assert(scoIds.every((x) => x >= 50000), 'sco fuera de su rango');
    const fx = await txt('files.xml');
    const files = [...fx.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)];
    eq(dup(files.map((m) => m[1])), [], 'file id repetido');
    const used = new Set();
    for (const m of files) {
      const h = /<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(m[2])[1];
      const e = `files/${h.slice(0, 2)}/${h}`;
      assert(z.file(e), `files.xml nombra ${e} y no está`);
      const b = await z.file(e).async('nodebuffer');
      eq(sha1(b), h, `sha1 de ${e}`);
      eq(Number(/<filesize>(\d+)<\/filesize>/.exec(m[2])[1]), b.length, `filesize de ${e}`);
      used.add(e);
    }
    const blobs = names.filter((n) => /^files\/[0-9a-f]{2}\/[0-9a-f]{40}$/.test(n));
    eq(blobs.filter((n) => !used.has(n)), [], 'blobs sin entrada en files.xml');
    // inforef de cada actividad: solo archivos que existen y son de SU contexto.
    const fileCtx = new Map(files.map((m) => [Number(m[1]), Number(/<contextid>(\d+)<\/contextid>/.exec(m[2])[1])]));
    for (const a of acts) {
      const ir = z.file(`${a.dir}/inforef.xml`) ? await txt(`${a.dir}/inforef.xml`) : '';
      const c = Number(/contextid="(\d+)"/.exec(await txt(`${a.dir}/${a.mod}.xml`))[1]);
      for (const m of ir.matchAll(/<file>\s*<id>(\d+)<\/id>/g)) eq(fileCtx.get(Number(m[1])), c, `${a.dir}/inforef: archivo ${m[1]} de su contexto`);
    }
    // Tokens: misma regla que el saneador de los builders (ctaMap: mid → modname real). Ninguno cambiaría.
    const kind = { SCORM: 'scorm', QUIZ: 'quiz', RESOURCE: 'resource', PAGE: 'page', HVP: 'hvp', LABEL: 'label' };
    const byMid = new Map(acts.map((a) => [a.mid, a.mod]));
    for (const a of acts) {
      const html = unesc(await txt(`${a.dir}/${a.mod}.xml`));
      for (const m of html.matchAll(/\$@([A-Z]+)VIEWBYID\*(\d+)@\$/g)) if (kind[m[1]]) eq(byMid.get(Number(m[2])), kind[m[1]], `${a.dir}: token ${m[0]}`);
    }
    // section.xml ↔ moodle_backup: cada actividad en una secuencia, una sola vez.
    const seqs = [];
    for (const n of names.filter((x) => /^sections\/[^/]+\/section\.xml$/.test(x))) seqs.push(...((/<sequence>([^<]*)<\/sequence>/.exec(await txt(n)) || [])[1] || '').split(',').filter(Boolean).map(Number));
    eq(dup(seqs), [], 'actividad repetida en las secuencias');
    eq([...seqs].sort((x, y) => x - y), [...modIds].sort((x, y) => x - y), 'secuencias = actividades del manifiesto');
    // Numeración: capítulos 1..N contiguos y cada actividad del capítulo nombra SU número.
    const inv = await inventoryOf(buf);
    const nums = inv.chapters.map((c) => c.number);
    eq(nums, nums.map((_, i) => i + 1), 'capítulos contiguos');
    for (const c of inv.chapters) for (const id of c.activities) {
      const a = acts.find((x) => x.mid === id);
      const m = /\b(?:Cap\.?|Capítulo)\s+(\d+)/.exec(a.title);
      if (m) eq(Number(m[1]), c.number, `«${a.title}» en el capítulo ${c.number}`);
    }
    if (expect.titles) for (const [n, t] of Object.entries(expect.titles)) eq(inv.chapters.find((c) => c.number === Number(n))?.title, t, `título del capítulo ${n}`);
    // Libro: cierra en </html>; títulos e índice 1..N; el capítulo nuevo adentro.
    const libro = inv.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    if (libro) {
      const f = libro.files.find((x) => /\.html$/.test(x.filename));
      const html = await z.file(f.blobEntry).async('string');
      assert(/<\/html>\s*$/.test(html), 'el Libro no cierra en </html>');
      const heads = [...html.matchAll(/<h1>Capítulo (\d+): ([^<]*)<\/h1>/g)].map((m) => Number(m[1]));
      eq(heads, nums, 'títulos del Libro = capítulos del curso');
      const toc = [...html.matchAll(/<span class="tt">Capítulo (\d+):/g)].map((m) => Number(m[1]));
      if (toc.length) eq(toc, nums, 'índice del Libro = capítulos del curso');
      if (expect.libroTitle) assert(html.includes(`Capítulo ${expect.libroTitle[0]}: ${expect.libroTitle[1]}`), 'el Libro no tiene el capítulo nuevo');
    }
    // Resumen «Capítulos …» de las secciones de módulo (lo pone el builder).
    for (const m of inv.modules) {
      const s = inv.sections.find((x) => x.number === m.sectionNumbers[0]);
      const sx = await txt(s.entry);
      const mm = /<summary>Capítulos? ([\d, y]+?) con /.exec(sx);
      if (mm) eq(OPS.parseChapterList(mm[1]), [...m.chapterNumbers].sort((x, y) => x - y), `resumen de la sección del módulo ${m.number}`);
    }
    return { inv, acts };
  };

  await check('C0 fixtures: V1 del builder real (patrón Gamma → texto → hvp → CTA → SCORM, 9 capítulos) y su variante vieja; invariantes del original', async () => {
    const inv = await inventoryOf(V1);
    eq(inv.family, 'v1-legacy-hvp', 'familia');
    eq(inv.chapters.map((c) => c.activities.map((m) => inv.activities.find((a) => a.moduleId === m).role).join('>')), Array(9).fill('presentation>text>video>cta>game'), 'patrón por capítulo');
    await invariants(V1);
    const old = await inventoryOf(V1old);
    eq(old.chapters.map((c) => c.activities.map((m) => old.activities.find((a) => a.moduleId === m).role).join('>'))[0], 'text>cta>game', 'variante vieja: ▶️ página → CTA → juego');
  });

  // ── plan: estimado por pieza y proveedor, tope mínimo, sin gasto ──
  let est1;
  await check('C1 plan: el ítem trae el capítulo (título, objetivo, posición), sus piezas, el costo por PIEZA y proveedor (catálogo), el tope mínimo = Σ cotas, riesgo alto con confirmación ítem por ítem y la estructura antes/después', async () => {
    const ctx = await ctxOf(V1);
    const call = await B.estimateContent(ctx, addReq(ctx, { module: 1, title: 'Lenguaje corporal', objective: 'Leer las señales del cliente', position: 2 }));
    assert(call && !call.unavailable, `estimado: ${JSON.stringify(call).slice(0, 300)}`);
    const v = B.estimateItemView(ctx, addReq(ctx, { module: 1, title: 'Lenguaje corporal', objective: 'Leer las señales del cliente', position: 2 }), call);
    est1 = call;
    eq(call.regen.pieces.map((p) => p.piece), ['libro', 'video_page', 'game_page', 'game', 'video', 'presentation'], 'piezas con costo');
    eq([...new Set(call.regen.providers.map((l) => l.provider))].sort(), ['anthropic', 'gamma', 'videogen', 'youtube'], 'proveedores');
    const sum = call.regen.pieces.reduce((a, p) => a + Number(p.boundUsd), 0);
    assert(Math.abs(sum - Number(call.regen.totalBoundUsd)) < 1e-6, `tope mínimo = Σ cotas (${sum} vs ${call.regen.totalBoundUsd})`);
    assert(Number(call.regen.totalBoundUsd) >= Number(call.expectedUsd), 'cota ≥ esperado');
    for (const p of call.regen.pieces) assert(Number(p.boundUsd) >= Number(p.expectedUsd) && Number(p.expectedUsd) > 0, `pieza ${p.piece}: ${p.expectedUsd} / ${p.boundUsd}`);
    eq([v.risk.level, v.requiresItemConfirm, v.generated, v.available], ['alto', true, false, true], 'riesgo / confirmación');
    eq(v.chapter.chapters, [{ number: 2, title: 'Lenguaje corporal', objective: 'Leer las señales del cliente', module: 1 }], 'capítulo nuevo (título, objetivo, posición)');
    eq(v.chapter.structure.after.slice(0, 4).map((x) => [x.number, x.title, x.isNew]), [[1, 'Escucha activa', false], [2, 'Lenguaje corporal', true], [3, 'Preguntas que ayudan', false], [4, 'Cierre de la conversación', false]], 'estructura después (renumerada)');
    eq(v.chapter.structure.before.length, 9, 'estructura antes');
    assert(/USD \d+\.\d{2}\b/.test(v.summary) && !/USD \d+\.\d{3,}/.test(v.summary + v.cost.basis), `USD con 2 decimales: ${v.summary}`);
  });

  await check('C2 avisos D7 (antes de aprobar): el audiolibro no incluye el capítulo nuevo (ofrece regenerate_audio) y el examen final no lo cubre (ofrece exam_question_add), con su costo; nada se encadena solo', async () => {
    const ctx = await ctxOf(V1);
    const call = await B.estimateContent(ctx, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }));
    const v = B.estimateItemView(ctx, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }), call);
    const w = v.misalignment.map((x) => [x.suggestedOperation, !!x.estimate]);
    assert(w.some(([o, e]) => o === 'regenerate_audio' && e), `audiolibro: ${JSON.stringify(w)}`);
    assert(w.some(([o, e]) => o === 'exam_question_add' && e), `examen final: ${JSON.stringify(w)}`);
    assert(v.misalignment.some((x) => /pasan a ser/.test(x.message)), 'aviso de renumeración');
  });

  await check('C3 sin aprobación → 0 llamadas (estimar no llama a ningún proveedor); tope < Σ cotas → 409 WORKSHOP_CAP_BELOW_CALL_BOUND (la regla de approveGeneration)', async () => {
    const prov = SIMLIB.simProviders(DIST);
    const ctx = await ctxOf(V1);
    await B.estimateContent(ctx, addReq(ctx, { module: 2, title: 'Llamadas difíciles' }));
    eq([prov.calls.anthropic.length, prov.calls.gamma.length, prov.calls.videogen.length, prov.calls.youtube.length], [0, 0, 0, 0], 'sin llamadas al estimar');
    const bound = SVC.paidBoundSum([est1]);
    eq(bound, Number(est1.regen.totalBoundUsd), 'Σ cotas del ítem');
    const exp = Number(est1.expectedUsd);
    assert(SVC.capBelowPaidBound((Math.ceil(exp * 110) / 100).toFixed(2), bound), 'tope ≥ esperado pero < Σ cotas → 409');
    assert(!SVC.capBelowPaidBound((Math.ceil(bound * 1e6) / 1e6).toFixed(6), bound), 'tope = Σ cotas → se aprueba');
    eq(PL.PLAN_ERRORS ? PL.PLAN_ERRORS.CAP_BELOW_CALL_BOUND : 'WORKSHOP_CAP_BELOW_CALL_BOUND', 'WORKSHOP_CAP_BELOW_CALL_BOUND', 'código');
    // Con un tope por debajo de Σ cotas, la compuerta corta ANTES de la llamada que no entra (nunca supera el tope).
    const r = await produce(V1, addReq(ctx, { module: 2, title: 'Llamadas difíciles' }), { capUsd: Number(est1.regen.pieces[0].boundUsd) + 0.0001 }).catch((e) => ({ err: e }));
    assert(r.err && r.err.code === 'cap_reached', `corte por tope: ${r.err ? r.err.message : 'sin corte'}`);
  });

  let mid;
  await check('C4 producción simulada en el MEDIO del módulo 1 (capítulo 2) → prueba en seco → aplicar → versión sin hallazgos nuevos; ids únicos, files.xml ↔ blobs, tokens válidos, renumeración, Libro con el capítulo', async () => {
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', objective: 'Leer las señales del cliente', position: 2 });
    const r = await produce(V1, req);
    eq(r.prep.status, 'resolved', `ítem: ${r.prep.reason}`);
    eq(r.gate.calls.map((c) => c.kind), ['anthropic:libro_chapter', 'anthropic:chapter_page', 'anthropic:chapter_page', ...Array(5).fill('anthropic:scorm_room'), 'videogen:render', 'youtube:upload', 'anthropic:video_interactions', 'gamma:generate'], 'llamadas por pieza');
    assert(r.gate.spentUsd <= Number(est1.regen.totalBoundUsd) + 1e-9, 'lo gastado ≤ Σ cotas');
    eq(r.prep.view.dryRun.ok, true, 'prueba en seco');
    // Resultado guardado (zip con binarios anidados) → se vuelve a cargar igual.
    const buf = await BU.encodeProduced(r.prep.produced);
    const back = await BU.decodeProduced(buf);
    assert(Buffer.isBuffer(back.presentation.pdf) && back.presentation.pdf.equals(r.prep.produced.presentation.pdf), 'binarios anidados ida y vuelta');
    const params = { ...r.prep.view.params, produced: back };
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [{ id: 'i1', requestId: 'r1', operation: 'add_chapter', quote: req.quote, summary: r.prep.view.summary, params }] });
    assert(run.ok, `aplicar: ${run.code} ${run.message}`);
    eq(run.diagnosis.introduced, [], 'sin hallazgos nuevos');
    const { inv } = await invariants(run.package, { titles: { 1: 'Escucha activa', 2: 'Lenguaje corporal', 3: 'Preguntas que ayudan', 10: 'Plan de mejora' }, libroTitle: [2, 'Lenguaje corporal'] });
    eq(inv.chapters.length, 10, '10 capítulos');
    const ch2 = inv.chapters.find((c) => c.number === 2);
    eq(ch2.activities.map((m) => inv.activities.find((a) => a.moduleId === m).role), ['presentation', 'text', 'video', 'cta', 'game'], 'patrón completo del capítulo nuevo');
    const titles = ch2.activities.map((m) => inv.activities.find((a) => a.moduleId === m).title);
    eq(titles, ['📊 Presentación Cap 2 — Lenguaje corporal', '📖 Capítulo 2 — Lenguaje corporal', '🎥 Video Interactivo Cap 2 — Lenguaje corporal', '🎯 Practicar — Cap 2', '🎮 Actividad Interactiva Cap 2 — Lenguaje corporal'], 'nombres del builder');
    const ch3 = inv.chapters.find((c) => c.number === 3);
    eq(inv.activities.find((a) => a.moduleId === ch3.activities[3]).title, '🎯 Practicar — Cap 3', 'CTA del posterior renumerado');
    // Lo no tocado sigue byte a byte: un capítulo de otro módulo (fuera de la renumeración solo cambia su nombre).
    const z0 = await JSZip.loadAsync(V1); const z1 = await JSZip.loadAsync(run.package);
    const keep = Object.keys(z0.files).filter((n) => /^activities\/hvp_\d+\/hvp\.xml$/.test(n));
    const same = [];
    const strip = (t) => t.replace(/<name>[^<]*<\/name>/, '').replace(/<slug>[^<]*<\/slug>/, '');
    for (const n of keep) if (strip(await z0.file(n).async('string')) === strip(await z1.file(n).async('string'))) same.push(n);
    eq(same.length, keep.length, 'videos existentes: idénticos salvo su nombre y su slug renumerados');
    assert(run.items[0].misalignment.some((m) => /audiolibro/.test(m)) && run.items[0].misalignment.some((m) => /examen final/.test(m)), 'avisos D7 en la versión');
    mid = run.package;
  });

  await check('C5 al FINAL del módulo y «sin video ni Gamma»: el capítulo va sin esas piezas (el plan lo dice); los posteriores renumerados; sin hallazgos nuevos', async () => {
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 2, title: 'Atención por chat', quote: 'Agrega un capítulo «Atención por chat» al módulo 2, sin video y sin Gamma.', omit: PL.omitOf('sin video y sin Gamma') });
    eq(req.details.omit, ['video', 'presentation'], 'omisiones del pedido');
    const call = await B.estimateContent(ctx, req);
    eq(call.regen.pieces.map((p) => p.piece), ['libro', 'video_page', 'game_page', 'game'], 'sin video ni Gamma en el costo');
    const r = await produce(V1, req);
    eq(r.prep.status, 'resolved', r.prep.reason);
    eq(r.prov.calls.videogen.length + r.prov.calls.gamma.length, 0, 'sin Videogen ni Gamma');
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [{ id: 'i1', requestId: 'r1', operation: 'add_chapter', quote: req.quote, summary: '', params: { ...r.prep.view.params, produced: r.prep.produced } }] });
    assert(run.ok, `${run.code} ${run.message}`);
    const { inv } = await invariants(run.package, { titles: { 7: 'Atención por chat', 8: 'Indicadores del servicio' } });
    const a7 = inv.chapters.find((c) => c.number === 7).activities.map((m) => inv.activities.find((a) => a.moduleId === m));
    eq(a7.map((a) => [a.role, a.title]), [['text', '▶️ Cap. 7 — Video: Atención por chat'], ['cta', '🎯 Practicar — Cap 7'], ['game', '🎮 Actividad Interactiva Cap 7 — Atención por chat']], 'sin video: la página del capítulo (como el builder sin hvp)');
  });

  await check('C6 variante vieja del V1 (▶️ página del capítulo → CTA → juego, sin hvp ni Gamma): patrón de ESE builder; páginas escritas por la IA', async () => {
    const ctx = await ctxOf(V1old);
    const req = addReq(ctx, { module: 3, title: 'Encuestas de satisfacción', position: 8 });
    const r = await produce(V1old, req);
    eq(r.prep.status, 'resolved', r.prep.reason);
    const run = await A.runApply({ original: V1old, expectedSha1: sha1(V1old), items: [{ id: 'i1', requestId: 'r1', operation: 'add_chapter', quote: req.quote, summary: '', params: { ...r.prep.view.params, produced: r.prep.produced } }] });
    assert(run.ok, `${run.code} ${run.message}`);
    const { inv } = await invariants(run.package, { titles: { 8: 'Encuestas de satisfacción', 9: 'Retroalimentación del equipo' } });
    const a8 = inv.chapters.find((c) => c.number === 8).activities.map((m) => inv.activities.find((a) => a.moduleId === m));
    eq(a8.map((a) => a.title), ['▶️ Cap. 8 — Video: Encuestas de satisfacción', '🎯 Practicar — Cap 8', '🎮 Actividad Interactiva Cap 8 — Encuestas de satisfacción'], 'nombres');
    assert(/Página del capítulo/.test(a8[0].html[0].html), 'la página es la del generador');
  });

  await check('C7 pieza fallida → NO se aplica nada: juego con «⚠️ Pendiente» / sala inválida, video sin preguntas, Libro cortado, página con «⚠️ Pendiente»; el motor rechaza un producido alterado', async () => {
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 });
    for (const [what, sim] of [['sala inválida', { fault: { scormRoom: 'invalid' } }], ['video sin preguntas', { fault: { vintNoQuestions: true } }], ['Libro cortado', { fault: { libroShort: true } }], ['página con Pendiente', { fault: { pagePending: true } }]]) {
      const r = await produce(V1, req, { sim }).catch((e) => ({ err: e }));
      assert(r.err || (r.prep && r.prep.status === 'failed' && !r.prep.view), `${what}: ${r.prep ? r.prep.status : ''}`);
    }
    const good = (await produce(V1, req)).prep;
    const t = good.view.params;
    for (const [what, mut] of [
      ['juego con «⚠️ Pendiente»', (p) => ({ ...p, scorm: { ...p.scorm, html: p.scorm.html.replace('</body>', '<p>⚠️ Pendiente: sala</p></body>') } })],
      ['video sin preguntas', (p) => { const j = JSON.parse(p.video.hvpJson); j.interactiveVideo.assets.interactions = []; return { ...p, video: { ...p.video, hvpJson: JSON.stringify(j) } }; }],
      ['sin presentación', (p) => ({ ...p, presentation: null })],
      ['otra posición', (p) => ({ ...p, chapterNumber: 5 })],
    ]) {
      const r = await ENG.applyPatchPlan({ original: V1, operations: [{ ...t, produced: mut(good.produced) }] });
      assert(!r.ok && !r.package, `${what}: se aplicó`);
    }
  });

  await check('C8 add_module con 2 capítulos y su examen de unidad (GIFT del generador, plantillas del builder): sección nueva, secciones siguientes bajan un número, Libro con índice del módulo; sin hallazgos nuevos', async () => {
    const ctx = await ctxOf(V1);
    const req = modReq({ title: 'Servicio digital', chapters: ['Redes sociales', 'Correo electrónico'] });
    const call = await B.estimateContent(ctx, req);
    eq(call.regen.pieces.map((p) => p.piece).filter((p) => !/^cap/.test(p)), ['exam', 'exam_page'], 'examen con costo');
    eq(call.regen.pieces.filter((p) => /^cap10:/.test(p.piece)).length, 6, 'piezas del capítulo 10');
    const r = await produce(V1, req, { capUsd: 80 });
    eq(r.prep.status, 'resolved', r.prep.reason);
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [{ id: 'i1', requestId: 'r1', operation: 'add_module', quote: req.quote, summary: '', params: { ...r.prep.view.params, produced: r.prep.produced } }] });
    assert(run.ok, `${run.code} ${run.message}`);
    const { inv, acts } = await invariants(run.package, { titles: { 10: 'Redes sociales', 11: 'Correo electrónico' }, libroTitle: [11, 'Correo electrónico'] });
    const m4 = inv.modules.find((m) => m.number === 4);
    assert(m4, `módulo 4: ${JSON.stringify(inv.modules.map((m) => [m.number, m.title]))}`);
    eq([m4.title, m4.chapterNumbers], ['Servicio digital', [10, 11]], 'módulo nuevo');
    const ex = inv.activities.find((a) => a.kind === 'exam' && a.unit === 4);
    assert(ex && ex.exam.questions.length === 25 && ex.exam.slots === 25, `examen de la unidad 4: ${ex ? ex.exam.questions.length : 'no'}`);
    eq([...new Set(ex.exam.questions.map((q) => q.qtype))].sort(), ['match', 'multichoice', 'truefalse'], 'tipos del GIFT');
    const secs = inv.sections.map((s) => [s.number, s.kind]);
    eq(secs.slice(-2), [[5, 'module'], [6, 'final']], 'sección nueva + final corrido');
    assert(acts.some((a) => a.title === 'ℹ️ Información: Examen Unidad 4'), 'página del examen');
    const z = await JSZip.loadAsync(run.package);
    const lib = inv.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    const html = await z.file(lib.files.find((f) => /\.html$/.test(f.filename)).blobEntry).async('string');
    assert(html.includes('MÓDULO 4 – Servicio digital'), 'índice del Libro con el módulo');
    assert(run.items[0].misalignment.some((m) => /audiolibro/.test(m)) && run.items[0].misalignment.some((m) => /examen final/.test(m)), 'avisos D7');
  });

  await check('C9 reutilización de lo pagado: si una pieza falla (Gamma ambiguo) el reintento reusa Libro, páginas, juego y video ya producidos (0 llamadas nuevas a esos) y nunca reenvía el ambiguo', async () => {
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 });
    const prior = {};
    const ext = { mode: 'inline', prior, onPaid: async (p) => { Object.assign(prior, JSON.parse(JSON.stringify(p))); } };
    const r1 = await produce(V1, req, { sim: { fault: { gammaCreate: 'rejected' } }, ext }).catch((e) => ({ err: e }));
    assert(r1.err && r1.err.code === 'provider_rejected', `1.ª: ${r1.err ? r1.err.message : r1.prep.status}`);
    const rec = prior.chapterPieces['2'];
    assert(rec.libroMd && rec.videoPageHtml && rec.scorm && rec.video && rec.videogen && rec.videogen.charged && rec.youtube, `pagado guardado: ${Object.keys(rec)}`);
    const ext2 = { mode: 'inline', prior, onPaid: async (p) => { Object.assign(prior, JSON.parse(JSON.stringify(p))); } };
    const r2 = await produce(V1, req, { ext: ext2 });
    eq(r2.prep.status, 'resolved', r2.prep.reason);
    eq(r2.gate.calls.map((c) => c.kind), ['gamma:generate'], 'solo lo que falta (Gamma): Libro, páginas, juego y video con sus preguntas se reusan');
    eq(r2.prov.calls.videogen.filter((c) => c.op === 'create').length + r2.prov.calls.youtube.length, 0, 'sin re-render ni re-subida');
  });

  await check('C10 no disponible con motivo: v3 (builder 3.x) en el plan y en el motor; V1 sin módulos (mínimo)', async () => {
    const SIM = await S.simulateCourse(DIST, COURSES.find((c) => c.id === 'A-S'));
    const v3 = SIM.built.mbz;
    const c3 = await ctxOf(v3);
    const m1 = c3.course.modules[0];
    const est = await B.estimateContent(c3, { ...addReq(c3, { module: m1.number, title: 'Capítulo nuevo' }) });
    assert(est && est.unavailable && /3\.x/.test(est.unavailable), `v3: ${JSON.stringify(est).slice(0, 200)}`);
    const r = await ENG.applyPatchPlan({ original: v3, operations: [{ op: 'add_chapter', moduleNumber: 1, position: 1, title: 'x', templateChapter: 1, expect: { templateModuleIds: [] }, produced: { kind: 'chapter' } }] });
    eq([r.ok, r.failure.code], [false, 'unavailable'], 'motor: v3 no disponible');
    const mini = await FX.miniV1(Buffer.alloc(16));
    const cm = await ctxOf(mini);
    const reqm = { ...addReq(cm, { module: 1, title: 'Tercero' }) };
    const em = await B.estimateContent(cm, reqm);
    assert(em && em.unavailable, `mínimo: ${JSON.stringify(em).slice(0, 200)}`);
  });

  await check('C11 interpretación (D6): título literal del pedido o pregunta; «sin video» / «sin Gamma» deterministas; posición fuera del módulo → pregunta', async () => {
    const ctx = await ctxOf(V1);
    const base = { quote: 'Agrega un capítulo sobre «Lenguaje corporal» en el módulo 1.', operation: 'add_chapter', instruction: 'Agregar capítulo', target: { moduleNumber: 1 }, colors: [], chapters: 1, reason: null, questions: [], targetEvidence: 'el módulo 1', changeEvidence: 'Lenguaje corporal' };
    const ok1 = PL.resolveRequest({ ...base, newChapters: [{ title: 'Lenguaje corporal', objective: null }], position: 2 }, ctx.course, { requestText: base.quote });
    eq([ok1.status, ok1.details.position, ok1.details.newChapters[0].title], ['resolved', 2, 'Lenguaje corporal'], 'resuelto');
    const q = PL.resolveRequest({ ...base, newChapters: null }, ctx.course, { requestText: base.quote });
    eq(q.status, 'needs_answer', 'sin título → pregunta');
    const far = PL.resolveRequest({ ...base, newChapters: [{ title: 'Lenguaje corporal', objective: null }], position: 8 }, ctx.course, { requestText: base.quote });
    eq(far.status, 'needs_answer', 'posición fuera del módulo → pregunta');
    let bad = null;
    try { PL.parseInterpretation({ requests: [{ ...base, newChapters: [{ title: 'Un título inventado' }] }] }, base.quote); } catch (e) { bad = e; }
    assert(bad && /literal/.test(bad.message), `título inventado rechazado: ${bad && bad.message}`);
    eq(PL.omitOf('hazlo sin videos y sin la presentación'), ['video', 'presentation'], 'omisiones');
  });

  // ── Ronda de correcciones 1 ──
  const ENGd = ENG; const SVCd = SVC;
  const libroAs = async (buf, fn) => FX.zipEdit(buf, async (z) => FX.replaceBlob(z, 'libro_guia_completo.html', fn));
  const itemOf = (id, r, op) => ({ id, requestId: `r${id}`, operation: op, quote: '', summary: '', params: { ...r.prep.view.params, produced: r.prep.produced } });

  await check('R1 (P1-1) precondiciones del motor ANTES de pagar: Libro con «1. …» (sin «Capítulo N:») → no disponible en el estimado y al preparar, con el motivo del motor y 0 llamadas', async () => {
    const bad = await libroAs(V1, (h) => h.replace(/<h1>Capítulo (\d+): /g, '<h1>$1. ').replace(/<span class="tt">Capítulo (\d+): /g, '<span class="tt">$1. '));
    const ctx = await ctxOf(bad);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 });
    const est = await B.estimateContent(ctx, req);
    assert(est && est.unavailable && /Capítulo N/.test(est.unavailable) && /No se llamó a ningún proveedor/.test(est.unavailable), `estimado: ${JSON.stringify(est).slice(0, 240)}`);
    const r = await produce(bad, req);
    eq([r.prep.status, r.gate.calls.length, Number(r.gate.spent())], ['unavailable', 0, 0], 'preparar: no disponible, 0 llamadas, USD 0');
  });

  await check('R2 (P1-2 c) dos ítems estructurales en el mismo plan (dos add_chapter, add_chapter + add_module) → WORKSHOP_STRUCTURAL_COMBINATION, mensaje sin voseo; uno solo aplica', async () => {
    const ctx = await ctxOf(V1);
    const rA = await produce(V1, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }));
    const rB = await produce(V1, addReq(ctx, { module: 3, title: 'Encuestas', position: 8 }));
    const rM = await produce(V1, modReq({ title: 'Digital', chapters: ['Redes'] }));
    for (const items of [[itemOf('a', rA, 'add_chapter'), itemOf('b', rB, 'add_chapter')], [itemOf('a', rA, 'add_chapter'), itemOf('m', rM, 'add_module')]]) {
      const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items });
      eq([run.ok, run.code], [false, A.STRUCTURAL_COMBINATION], 'combinación rechazada');
      assert(/dos rondas/.test(run.message) && !/\b(aplicá|quitá|pedí|vos|tenés)\b/.test(run.message), `mensaje: ${run.message}`);
    }
    eq(A.STRUCTURAL_COMBINATION, 'WORKSHOP_STRUCTURAL_COMBINATION', 'código');
    const one = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('b', rB, 'add_chapter')] });
    assert(one.ok, `uno solo: ${one.message}`);
  });

  await check('R3 (P1-2 a / d) add_chapter en la posición 2 + edit_libro_section del capítulo 5 en el MISMO plan: al aplicar, lo estructural va al final y se edita el capítulo 5 ORIGINAL; el motor solo (en el otro orden) falla stale_target por el título esperado', async () => {
    const ctx = await ctxOf(V1);
    const rA = await produce(V1, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }));
    const libro = ctx.course.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    const body = '<h2>5.1 Reescrito</h2><p>' + 'Texto reescrito del capítulo cinco para la prueba. '.repeat(20) + '</p>';
    const edit = { op: 'edit_libro_section', moduleId: libro.moduleId, chapters: [{ number: 5, html: body, expectTitle: 'Reclamos por escrito' }] };
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('a', rA, 'add_chapter'), { id: 'e', requestId: 're', operation: 'edit_libro_section', quote: '', summary: '', params: edit }] });
    assert(run.ok, `${run.code} ${run.message}`);
    const z = await JSZip.loadAsync(run.package);
    const inv = await inventoryOf(run.package);
    const lb = inv.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    const html = await z.file(lb.files.find((f) => /\.html$/.test(f.filename)).blobEntry).async('string');
    const i = html.indexOf('5.1 Reescrito');
    eq([...html.slice(0, i).matchAll(/<h1>([^<]*)<\/h1>/g)].pop()[1], 'Capítulo 6: Reclamos por escrito', 'se editó el capítulo correcto (ahora 6)');
    eq(run.items.map((x) => x.operation), ['edit_libro_section', 'add_chapter'], 'lo estructural al final');
    const r = await ENGd.applyPatchPlan({ original: V1, operations: [{ ...rA.prep.view.params, produced: rA.prep.produced }, edit] });
    eq([r.ok, r.failure && r.failure.code], [false, 'stale_target'], 'en el otro orden, el título esperado lo frena');
  });

  await check('R4 (P1-2 b / P2-3) remove_activity + add_chapter en el mismo plan aplica: lo esperado sale de los parámetros (piezas × capítulos) menos lo quitado', async () => {
    const ctx = await ctxOf(V1);
    const rA = await produce(V1, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }));
    const forum = ctx.course.activities.find((a) => a.modname === 'forum');
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('a', rA, 'add_chapter'), { id: 'x', requestId: 'rx', operation: 'remove_activity', quote: '', summary: '', params: { op: 'remove_activity', moduleId: forum.moduleId } }] });
    assert(run.ok, `${run.code} ${run.message}`);
    await invariants(run.package);
    // Quitar una actividad DEL capítulo molde vecino también cuenta (el capítulo sigue existiendo).
    const cta3 = ctx.course.chapters.find((c) => c.number === 3).activities.map((m) => ctx.course.activities.find((a) => a.moduleId === m)).find((a) => a.role === 'presentation');
    const run2 = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('a', rA, 'add_chapter'), { id: 'y', requestId: 'ry', operation: 'remove_activity', quote: '', summary: '', params: { op: 'remove_activity', moduleId: cta3.moduleId } }] });
    assert(run2.ok, `quitar en un capítulo + agregar: ${run2.code} ${run2.message}`);
  });

  await check('R5 (P1-3) el molde se busca por sus actividades (expect.templateModuleIds), no por número: con el capítulo molde renumerado por otro ítem el motor lo encuentra; con actividades distintas falla stale_target', async () => {
    const ctx = await ctxOf(V1);
    const rB = await produce(V1, addReq(ctx, { module: 3, title: 'Encuestas', position: 8 }));
    const tpl = OPS.templateOf(ctx.course, 99, rB.prep.view.params.expect.templateModuleIds);
    eq(tpl.number, rB.prep.view.params.templateChapter, 'por ids aunque el número no exista');
    let e = null;
    try { OPS.templateOf(ctx.course, rB.prep.view.params.templateChapter, [1, 2, 3]); } catch (x) { e = x; }
    eq(e && e.code, 'stale_target', 'actividades distintas');
  });

  await check('R6 (P1-4) preguntas sin bucle: responder el título resuelve; responder la posición (opción) resuelve con ella y conserva el título', async () => {
    const ctx = await ctxOf(V1);
    const base = { quote: 'Agrega un capítulo en el módulo 1.', operation: 'add_chapter', instruction: 'Agregar capítulo', target: { moduleNumber: 1 }, colors: [], chapters: 1, reason: null, questions: [], targetEvidence: 'el módulo 1', changeEvidence: null };
    const q = PL.resolveRequest({ ...base, newChapters: null }, ctx.course, { requestText: base.quote });
    eq(q.status, 'needs_answer', 'pregunta el título');
    const a = PL.answerRequest(q, [{ questionId: q.questions[0].id, text: 'Lenguaje corporal' }], ctx.course);
    eq([a.resolved.status, a.resolved.details.newChapters], ['resolved', [{ title: 'Lenguaje corporal', objective: null }]], 'título → resuelto');
    const Q2 = 'Agrega un capítulo «Lenguaje corporal» en el módulo 1.';
    const far = PL.resolveRequest({ ...base, quote: Q2, newChapters: [{ title: 'Lenguaje corporal', objective: null }], position: 8 }, ctx.course, { requestText: Q2 });
    eq(far.status, 'needs_answer', 'posición fuera del módulo → pregunta');
    const b = PL.answerRequest(far, [{ questionId: far.questions[0].id, optionId: far.questions[0].options[1].id }], ctx.course);
    eq([b.resolved.status, b.resolved.details.position, b.resolved.details.newChapters[0].title], ['resolved', 2, 'Lenguaje corporal'], 'posición → resuelto, título conservado');
  });

  await check('R7 (P1-5) la página del video no queda «Video en preparación»: con video, el prompt reserva el espacio (no «VIDEO PENDIENTE») y el motor lo resuelve; fuera del espacio → no se aplica; «sin video» → el bloque se quita', async () => {
    const CH = L('modules/course-workshop/regenerate/chapter.js');
    const ctx = await ctxOf(V1);
    const spec = { chapterNumber: 2, title: 'Lenguaje corporal', objective: null, moduleNumber: 1, moduleTitle: 'Fundamentos', pieces: ['presentation', 'text', 'video', 'cta', 'game'], pages: { videoPage: true, gamePage: true } };
    const pr = CH.chapterPrompts(spec, ctx.course, null);
    assert(!/VIDEO PENDIENTE/.test(pr.video.user) && /CC_VIDEO_SLOT_START/.test(pr.video.user), 'con video: espacio reservado');
    const pr2 = CH.chapterPrompts({ ...spec, pieces: ['presentation', 'text', 'cta', 'game'] }, ctx.course, null);
    assert(/VIDEO PENDIENTE/.test(pr2.video.user), 'sin video: el prompt pide el placeholder (que la producción quita)');
    for (const [label, req] of [['con video', addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 })], ['sin video', addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2, omit: ['video'] })]]) {
      const r = await produce(V1, req);
      eq(r.prep.status, 'resolved', `${label}: ${r.prep.reason}`);
      const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('a', r, 'add_chapter')] });
      assert(run.ok, `${label}: ${run.message}`);
      const z = await JSZip.loadAsync(run.package);
      for (const n of Object.keys(z.files).filter((x) => /^activities\/(label|hvp)_\d+\/(label|hvp)\.xml$/.test(x))) {
        const t = unesc(await z.file(n).async('string'));
        assert(!/Video en preparación|CC_VIDEO_SLOT/.test(t), `${label}: ${n} quedó con el marcador del video`);
      }
    }
    const bad = await produce(V1, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }), { sim: { fault: { videoPlaceholder: true } } }).catch((e) => ({ err: e }));
    assert(bad.err || (bad.prep.status === 'failed' && !bad.prep.view), `«Video en preparación» afuera: ${bad.prep ? bad.prep.status : ''}`);
    const ok1 = (await produce(V1, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }))).prep;
    const inj = { ...ok1.produced, videoPageHtml: ok1.produced.videoPageHtml + '<p>Video en preparación: disponible próximamente</p>' };
    const rr = await ENGd.applyPatchPlan({ original: V1, operations: [{ ...ok1.view.params, produced: inj }] });
    assert(!rr.ok, 'el motor no inserta una página con el marcador');
  });

  await check('R8 (P2-1) la cota del estimado (misma fuente de la base que la producción) ≥ la suma de las cotas de los tickets reales', async () => {
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 });
    ctx.regenDbLoader = async () => ({ chapterMd: new Map(), contextPackage: new Map(), courseContext: { sector: 'Comercio', pais: 'Colombia', tono: 'cercano' }, tiedTo: null, unavailable: null });
    const est = await B.estimateContent(ctx, req);
    const prov = SIMLIB.simProviders(DIST); const gate = SIMLIB.memGate(DIST, { capUsd: 50 });
    const prep = await B.prepareRegenItem(ctx, req, { providers: prov, gate, spent: () => gate.spent() });
    eq(prep.status, 'resolved', prep.reason);
    const tickets = gate.calls.reduce((a, c) => a + Number(c.boundUsd), 0);
    assert(tickets <= Number(est.regen.totalBoundUsd) + 1e-9, `tickets ${tickets} ≤ estimado ${est.regen.totalBoundUsd}`);
  });

  await check('R9 (P2-2 / P2-6) slug del hvp nuevo con su número y los posteriores renumerados (sin repetidos); sco nuevos por encima de TODO id del paquete original', async () => {
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('a', await produce(V1, addReq(await ctxOf(V1), { module: 2, title: 'Nuevo X', position: 4 })), 'add_chapter')] });
    assert(run.ok, run.message);
    const z = await JSZip.loadAsync(run.package);
    const inv = await inventoryOf(run.package);
    const slugs = [];
    for (const c of inv.chapters) for (const m of c.activities) {
      const a = inv.activities.find((x) => x.moduleId === m);
      if (a.modname !== 'hvp') continue;
      const slug = /<slug>([^<]*)<\/slug>/.exec(await z.file(`${a.dir}/hvp.xml`).async('string'))[1];
      eq(slug, `interactive-video-${c.number}`, `slug del capítulo ${c.number}`);
      slugs.push(slug);
    }
    eq(new Set(slugs).size, slugs.length, 'slugs únicos');
    const z0 = await JSZip.loadAsync(V1);
    let maxGeneral = 0;
    for (const n of Object.keys(z0.files).filter((x) => /\.xml$/.test(x))) for (const m of (await z0.file(n).async('string')).matchAll(/\bid="(\d+)"/g)) maxGeneral = Math.max(maxGeneral, Number(m[1]));
    const sco = (run.items[0].idsAssigned.sco || []);
    assert(sco.length === 4 && sco.every((x) => x > maxGeneral && x >= 60000), `sco nuevos ${sco} > ${maxGeneral}`);
  });

  await check('R10 (P2-4) otro archivo del paquete con el MISMO contenido que el Libro no cambia de blob (solo la entrada del Libro)', async () => {
    const z = await JSZip.loadAsync(V1);
    const fx = await z.file('files.xml').async('string');
    const lib = [...fx.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].find((m) => /libro_guia_completo\.html/.test(m[2]));
    const welcome = (await inventoryOf(V1)).activities.find((a) => a.kind === 'welcome');
    const copy = lib[0].replace(`<file id="${lib[1]}">`, '<file id="999991">').replace(/<contextid>\d+<\/contextid>/, `<contextid>${welcome.contextId}</contextid>`).replace(/<component>[^<]*<\/component>/, '<component>mod_label</component>').replace(/<filearea>[^<]*<\/filearea>/, '<filearea>intro</filearea>').replace(/<filename>[^<]*<\/filename>/, '<filename>copia-libro.html</filename>');
    z.file('files.xml', fx.replace('</files>', `${copy}</files>`));
    const V1c = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const h0 = /<contenthash>(\w+)/.exec(lib[2])[1];
    const r = await produce(V1c, addReq(await ctxOf(V1c), { module: 1, title: 'Lenguaje corporal', position: 2 }));
    eq(r.prep.status, 'resolved', r.prep.reason);
    const run = await A.runApply({ original: V1c, expectedSha1: sha1(V1c), items: [itemOf('a', r, 'add_chapter')] });
    assert(run.ok, run.message);
    const z1 = await JSZip.loadAsync(run.package);
    const fx1 = await z1.file('files.xml').async('string');
    const cp = [...fx1.matchAll(/<file id="999991">([\s\S]*?)<\/file>/g)][0][1];
    eq(/<contenthash>(\w+)/.exec(cp)[1], h0, 'la copia conserva su blob');
    assert(z1.file(`files/${h0.slice(0, 2)}/${h0}`), 'el blob viejo sigue (lo usa la copia)');
  });

  await check('R11 (P2-5) lo pagado se ata al pedido exacto: otro título u otras piezas omitidas → otra clave (no se reusa)', async () => {
    const k = (t, omit) => SVCd.regenTargetKey({ operation: 'add_chapter', target: { kind: 'module', moduleNumber: 1 }, details: { position: 2, newChapters: [{ title: t }], omit } });
    assert(k('A', []) !== k('B', []) && k('A', []) !== k('A', ['video']) && k('A', ['video', 'presentation']) === k('A', ['presentation', 'video']), 'claves');
    const m = (t) => SVCd.regenTargetKey({ operation: 'add_module', target: { kind: 'course' }, details: { moduleTitle: 'M', newChapters: t.map((x) => ({ title: x })), omit: [] } });
    assert(m(['A', 'B']) !== m(['A', 'C']), 'módulo: capítulos');
  });

  await check('R12 (ronda 2, P2-C) el marcador es solo «Video en preparación» y CC_VIDEO_SLOT: «disponible próximamente» en el contenido es legítimo', async () => {
    const CH = L('modules/course-workshop/regenerate/chapter.js');
    const txt = 'texto largo de la página del capítulo con ejemplos y pasos. '.repeat(6);
    const ok = `<div><p>${txt}La guía ampliada estará disponible próximamente en la biblioteca.</p></div>`;
    eq(CH.cleanPage(ok), ok, 'frase legítima aceptada');
    assert(!OPS.VIDEO_PENDING_RE.test(ok), 'no es el marcador');
    let e = null; try { CH.cleanPage(`<div><p>${txt}</p><p>Video en preparación</p></div>`); } catch (x) { e = x; }
    assert(e && /Video en preparación/.test(e.message), 'el marcador se rechaza');
    assert(OPS.VIDEO_PENDING_RE.test('<!-- CC_VIDEO_SLOT_START -->'), 'el bloque sin resolver se rechaza');
  });

  await check('R13 (ronda 2, P2-A) add_chapter + quitar una actividad DE SU MOLDE en el mismo plan → combinación (dos rondas): regla pura de la aprobación antes de gastar y defensa en aplicar; quitar otra actividad sí aplica', async () => {
    const ctx = await ctxOf(V1);
    const est = await B.estimateContent(ctx, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }));
    const tpl = est.regen.templateModuleIds;
    assert(Array.isArray(tpl) && tpl.length === 5, `el estimado trae el molde: ${JSON.stringify(tpl)}`);
    eq(A.removesTemplate(tpl, [tpl[3]]), [tpl[3]], 'quitar el CTA del molde → combinación');
    eq(A.removesTemplate(tpl, [ctx.course.activities.find((a) => a.modname === 'forum').moduleId]), [], 'quitar el foro → no');
    const r = await produce(V1, addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 }));
    const ctaTitle = ctx.course.activities.find((a) => a.moduleId === tpl[3]).title;
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('a', r, 'add_chapter'), { id: 'x', requestId: 'rx', operation: 'remove_activity', quote: '', summary: ctaTitle, params: { op: 'remove_activity', moduleId: tpl[3] } }] });
    eq([run.ok, run.code], [false, A.STRUCTURAL_COMBINATION], 'aplicar también lo frena');
    // Ronda 3 (P2-E): mensaje propio que nombra la actividad del molde y explica las dos rondas (sin voseo).
    assert(run.message.includes(`«${ctaTitle}»`) && /modelo para el capítulo nuevo/.test(run.message) && /dos rondas/.test(run.message) && !/más de un cambio que agrega/.test(run.message) && !/\b(aplicá|quitá|pedí|vos)\b/.test(run.message), `mensaje: ${run.message}`);
  });

  await check('R14 (ronda 2, P2-B) lo que el sintético no cubre se valida ANTES de guardar la pieza: un Libro con otro «Capítulo K:» adentro se rechaza y NO queda guardado (el reintento lo rehace); el motor también lo rechaza', async () => {
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 });
    const prior = {};
    const ext = { mode: 'inline', prior, onPaid: async (p) => { Object.assign(prior, JSON.parse(JSON.stringify(p))); } };
    const r = await produce(V1, req, { sim: { fault: { libroExtraHeading: true } }, ext }).catch((e) => ({ err: e }));
    assert(r.err ? r.err.code === 'invalid_result' : r.prep.status === 'failed', `rechazado: ${r.err ? r.err.message : r.prep.reason}`);
    assert(!(prior.chapterPieces && prior.chapterPieces['2'] && prior.chapterPieces['2'].libroMd), 'el Libro inválido no quedó guardado');
    const CH = L('modules/course-workshop/regenerate/chapter.js');
    eq(CH.libroExtraChapterHeadings('# Capítulo 2: A\n\n## 2.1 x\n\n## Capítulo 3: B'), ['Capítulo 3: B'], 'detector');
    const good = (await produce(V1, req)).prep;
    const bad = { ...good.produced, libroMd: `${good.produced.libroMd}\n\n## Capítulo 3: Otro tema\n\nTexto.` };
    const rr = await ENGd.applyPatchPlan({ original: V1, operations: [{ ...good.view.params, produced: bad }] });
    assert(!rr.ok && /Capítulo K/.test(rr.failure.message), `motor: ${rr.failure && rr.failure.message}`);
  });

  await check('R15 (ronda 2, P2-B) el motor rechaza el contenido REAL por un hallazgo nuevo (enlace muerto en la página) → la pieza culpable se DESCARTA de lo pagado, el ítem dice el costo del reintento, y el reintento la rehace (pagando solo eso) y aplica', async () => {
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 });
    const prior = {};
    const ext = { mode: 'inline', prior, onPaid: async (p) => { for (const k of Object.keys(prior)) delete prior[k]; Object.assign(prior, JSON.parse(JSON.stringify(p))); } };
    const r1 = await produce(V1, req, { sim: { fault: { pageDeadLink: true } }, ext });
    eq(r1.prep.status, 'failed', 'el motor lo rechaza');
    assert(/El reintento rehace/.test(r1.prep.reason) && /USD \d+\.\d{2}\b/.test(r1.prep.reason) && !/USD \d+\.\d{3,}/.test(r1.prep.reason), `costo del reintento visible: ${r1.prep.reason}`);
    const rec = prior.chapterPieces['2'];
    assert(!rec.videoPageHtml && !rec.gamePageHtml, 'páginas descartadas');
    assert(rec.libroMd && rec.scorm && rec.videogen && rec.videogen.charged, 'lo demás pagado se conserva');
    const ext2 = { mode: 'inline', prior, onPaid: async (p) => { for (const k of Object.keys(prior)) delete prior[k]; Object.assign(prior, JSON.parse(JSON.stringify(p))); } };
    const r2 = await produce(V1, req, { ext: ext2 });
    eq(r2.prep.status, 'resolved', r2.prep.reason);
    eq(r2.gate.calls.map((c) => c.kind), ['anthropic:chapter_page', 'anthropic:chapter_page'], 'el reintento solo rehace las páginas (sin render ni Gamma nuevos)');
    const run = await A.runApply({ original: V1, expectedSha1: sha1(V1), items: [itemOf('a', r2, 'add_chapter')] });
    assert(run.ok, run.message);
  });

  await check('R16 (ronda 3, P2-F) solo una falla de CONTENIDO descarta piezas: un invariant de conteo (u otro determinista) → 0 piezas descartadas, falla no reintentable con motivo visible y el reintento no paga nada', async () => {
    const CH = L('modules/course-workshop/regenerate/chapter.js');
    eq(CH.discardPolicy('invariant', 'El paquete nuevo tiene 0 capítulo(s) y 4 actividad(es) de diferencia; el plan pide 1 y 5.'), { pieces: [], contentFailure: false }, 'conteo');
    eq(CH.discardPolicy('invariant', 'El paquete nuevo no abre: x'), { pieces: [], contentFailure: false }, 'no abre');
    eq(CH.discardPolicy('invariant', 'El Libro resultante no quedó con sus capítulos en orden.').pieces, ['libroMd'], 'invariante de contenido');
    assert(CH.discardPolicy('new_findings', 'El botón «Ver más» [dead_link]').pieces.length > 0, 'hallazgo nuevo');
    const ctx = await ctxOf(V1);
    const req = addReq(ctx, { module: 1, title: 'Lenguaje corporal', position: 2 });
    const prior = {};
    const ext = { mode: 'inline', prior, onPaid: async (p) => { for (const k of Object.keys(prior)) delete prior[k]; Object.assign(prior, JSON.parse(JSON.stringify(p))); } };
    const real = ENGd.applyPatchPlan;
    ENGd.applyPatchPlan = async (inp) => {
      const p = inp.operations[0] && inp.operations[0].produced;
      if (p && p.kind === 'chapter' && p.video && p.video.videogenJobId !== 'dry-run') return { ok: false, package: null, container: 'zip', sha1: null, operations: [], diagnosis: null, preservedEntries: 0, failure: { opIndex: null, op: null, code: 'invariant', message: 'El paquete nuevo tiene 0 capítulo(s) y 4 actividad(es) de diferencia; el plan pide 1 y 5.' } };
      return real(inp);
    };
    let r1;
    try { r1 = await produce(V1, req, { ext }); } finally { ENGd.applyPatchPlan = real; }
    eq([r1.prep.status, r1.prep.failure && r1.prep.failure.retryable], ['failed', false], 'falla no reintentable');
    assert(/reintentar no la arregla/.test(r1.prep.reason) && !/El reintento rehace/.test(r1.prep.reason), `motivo: ${r1.prep.reason}`);
    const rec = prior.chapterPieces['2'];
    assert(rec.libroMd && rec.videoPageHtml && rec.gamePageHtml && rec.scorm && rec.video, `0 piezas descartadas: ${Object.keys(rec)}`);
    const ext2 = { mode: 'inline', prior, onPaid: async (p) => { for (const k of Object.keys(prior)) delete prior[k]; Object.assign(prior, JSON.parse(JSON.stringify(p))); } };
    const r2 = await produce(V1, req, { ext: ext2 });
    eq([r2.prep.status, r2.gate.calls.length], ['resolved', 0], 'el reintento no paga nada (todo se reusa)');
  });

  await check('R17 (ronda 3, P2-G) add_module: si se descarta TODO, el costo del reintento suma el examen y su página', async () => {
    const CH = L('modules/course-workshop/regenerate/chapter.js');
    const ctx = await ctxOf(V1);
    const est = await B.estimateContent(ctx, modReq({ title: 'Servicio digital', chapters: ['Redes sociales', 'Correo electrónico'] }));
    const all = CH.retryCostOf(est.regen, CH.TEXT_PIECES, true);
    const noExam = CH.retryCostOf(est.regen, CH.TEXT_PIECES, false);
    assert(all.pieces.includes('exam') && all.pieces.includes('exam_page') && !noExam.pieces.includes('exam'), `piezas: ${all.pieces}`);
    const exam = est.regen.pieces.filter((p) => p.piece === 'exam' || p.piece === 'exam_page');
    eq(exam.length, 2, 'el estimado del módulo trae examen y página');
    const add = (k) => exam.reduce((a, p) => a + Number(p[k]), 0);
    assert(Math.abs(all.expectedUsd - noExam.expectedUsd - add('expectedUsd')) < 1e-9 && Math.abs(all.boundUsd - noExam.boundUsd - add('boundUsd')) < 1e-9, 'suma exacta del examen');
    const pages = CH.retryCostOf(est.regen, ['videoPageHtml', 'gamePageHtml'], false);
    eq(pages.pieces, ['video_page', 'game_page'], 'descartar solo páginas no rehace el examen');
  });

  const total = Object.values(REAL).reduce((a, b) => a + b, 0);
  await check('C12 cero llamadas reales (anthropic, openai, fetch, undici, http, net, binarios)', async () => eq(total, 0, JSON.stringify(REAL)));
  if (process.env.R107_ADD_CHAPTER_OUT && mid) fs.writeFileSync(process.env.R107_ADD_CHAPTER_OUT, mid);
  console.log(`\n${fail ? '❌' : '✅'} check-r107-add-chapter: ${ok}/${ok + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
