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
  ];
  const tmp = fs.mkdtempSync(path.join(REPO, '.r107-bite-'));
  let code = 0;
  try {
    for (const b of bites) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, FILE);
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
    assert(!SVC.capBelowPaidBound(bound.toFixed(6), bound), 'tope = Σ cotas → se aprueba');
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
    for (const n of keep) if ((await z0.file(n).async('string')).replace(/<name>[^<]*<\/name>/, '') === (await z1.file(n).async('string')).replace(/<name>[^<]*<\/name>/, '')) same.push(n);
    eq(same.length, keep.length, 'videos existentes: idénticos salvo su nombre renumerado');
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

  const total = Object.values(REAL).reduce((a, b) => a + b, 0);
  await check('C12 cero llamadas reales (anthropic, openai, fetch, undici, http, net, binarios)', async () => eq(total, 0, JSON.stringify(REAL)));
  if (process.env.R107_ADD_CHAPTER_OUT && mid) fs.writeFileSync(process.env.R107_ADD_CHAPTER_OUT, mid);
  console.log(`\n${fail ? '❌' : '✅'} check-r107-add-chapter: ${ok}/${ok + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
