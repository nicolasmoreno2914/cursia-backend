#!/usr/bin/env node
/* eslint-disable */
// r107 B10 · Taller de cursos — Fase 3: REHACER una actividad (juego SCORM / práctica H5P, video H5P, presentación de
// Gamma, audio de bienvenida y audiolibro) con los generadores EXISTENTES, contra el código COMPILADO (dist/).
//
// USD 0: TODOS los proveedores SIMULADOS (Anthropic, OpenAI TTS, Videogen, Gamma, YouTube, pdftoppm, ffmpeg). El SDK de
// Anthropic, fetch, http(s), net/tls y los binarios nativos están BLOQUEADOS: si algo intenta salir, el check falla.
// Fixtures: el v3 A-S del motor de la simulación comercial y el V1 mínimo de B3/B4 (variantes con YouTube y Libro largos).
//
//   G0  red y SDK bloqueados; el simulador no toca nada real
//   R0  las marcas de mecánica del juego (SCORM v2) salen SOLO del renderizador de su plantilla (ejecutor vendorizado)
//   R1  plan: cada operación (v3 + V1) con su estimado POR PROVEEDOR = estimator de FinOps con los items del generador;
//       cotas del catálogo; tope propuesto ≥ Σ cotas; lo que no se puede rehacer → no disponible con motivo
//   R2  sin aprobación → 0 llamadas: estimar no llama a nadie; prepareItem no produce; tope 0 → corta ANTES de llamar
//   R3  producción simulada → resultado validado → aplicar (runApply) → versión con diagnóstico y validador SIN
//       hallazgos nuevos, por operación y combinada (v3 + V1); lo verificable del antes/después en la vista
//   R4  resultado inválido NUNCA se aplica: sala inválida del generador, SCORM con «⚠️ Pendiente» / salas de menos,
//       audiolibro sin un capítulo, guion corto, video sin preguntas, resultado alterado
//   R5  llamada ambigua (Gamma 502, render de Videogen sin terminar) → sin reenvío automático, la cota cuenta como
//       gastada y la reserva queda PENDIENTE (closeReservation); 429 de TTS → sin cobro; YouTube sin conexión → 0 gasto
//   R6  D7: rehacer el video avisa que el Libro y las preguntas del examen del capítulo pueden quedar desalineados
//   R7  motor: precondición vencida, resultado de otra actividad, ids sco en su rango 60000+ sin repetir, artifact
//       (zip determinista) ida y vuelta con huella, catálogo de la interpretación
//
// Uso: npm run build && node scripts/r107/check-r107-regenerate.js --ci [--dist dist]
'use strict';
require('reflect-metadata');
const path = require('path');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
if (!argv.includes('--ci')) { console.error('Uso: --ci [--dist dist]'); process.exit(2); }
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const SIMLIB = require(path.join(REPO, 'scripts/r107/lib/r107-regen-sim.js'));
const REAL = SIMLIB.blockNetwork('r107 B10 check');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

let ok = 0; let fail = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha = (alg, b) => crypto.createHash(alg).update(b).digest('hex');
const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${e.message}`); process.exit(1); } };

(async () => {
  const PL = L('modules/course-workshop/plan/index.js');
  const B = L('modules/course-workshop/plan/builder.js');
  const A = L('modules/course-workshop/apply/apply-core.js');
  const AL = L('modules/course-workshop/plan/approval-ledger.js');
  const RG = L('modules/course-workshop/regenerate/types.js');
  const TG = L('modules/course-workshop/regenerate/target.js');
  const BU = L('modules/course-workshop/regenerate/bundle.js');
  const PR = L('modules/course-workshop/regenerate/produce.js');
  const ENG = L('modules/course-workshop/patch/engine.js');
  const R = L('modules/course-workshop/mbz-reader.js');
  const I = L('modules/course-workshop/identify.js');
  const INV = L('modules/course-workshop/inventory.js');
  const EST = L('modules/finops/estimator.js');
  const UM = L('modules/finops/usage-model.js');
  const DRY = L('modules/pedagogy/dry-run.js');
  const EX = L('workers/llm-executor/executor-runtime.js');
  const AUD = L('package/audio/index.js');
  const FX = require(path.join(REPO, 'scripts/r107/lib/r107-fixtures.js'));
  const S = require(path.join(REPO, 'scripts/lib/commercial-simulation'));
  const COURSES = require(path.join(REPO, 'scripts/fixtures/commercial-simulation/courses.json')).courses;
  const JSZip = require('jszip');
  const vm = require('vm');
  const PRICING = DRY.seedPricing();

  // ── fixtures ──
  const SIM = await S.simulateCourse(DIST, COURSES.find((c) => c.id === 'A-S'));
  const AS = SIM.built.mbz;
  const V1base = await FX.miniV1(await FX.audiobookOf(AS));
  // V1 con YouTube real (el mínimo trae ids inválidos) y un Libro Guía con capítulos largos (fuente del audiolibro).
  const longCh = (n) => Array.from({ length: 14 }, (_, i) => `<p>En el capítulo ${n}, la idea ${i + 1} explica cómo atender a un cliente con calma, escuchar su problema, confirmar lo entendido con palabras propias y acordar un próximo paso claro que se pueda cumplir en el servicio diario.</p>`).join('');
  const V1 = await FX.zipEdit(V1base, async (z) => {
    for (const n of [1, 2]) await FX.editHvp(z, `hvp_${900 + n * 10 + 1}`, (j) => { j.interactiveVideo.video.files[0].path = `https://youtu.be/Abc${n}Def${n}Ghi`; return j; });
    await FX.replaceBlob(z, 'libro_guia_completo.html', (html) => html.replace('<p>Contenido del primero.</p>', longCh(1)).replace('<p>Contenido del segundo.</p>', longCh(2)));
  });
  const inventoryOf = async (buf) => { const pkg = await R.openMbz(buf); const f = await I.readPackageFacts(pkg, 'x.mbz'); return INV.buildInventory(pkg, { family: I.familyOf(f), builderLine: I.builderLineOf(f) }); };
  const ctxOf = async (buf, db = null) => { const c = await PL.openBuildCtx ? null : null; const ctx = await B.openBuildCtx(buf, { originalSha1: sha('sha1', buf), pricing: PRICING }); if (db) ctx.regenDb = db; ctx.ttsModel = 'gpt-4o-mini-tts-2025-03-20'; return ctx; };
  const reqFor = (ctx, op, moduleId, extra = {}) => {
    const a = ctx.course.activities.find((x) => x.moduleId === moduleId);
    return { quote: extra.quote || 'Rehacer la actividad', instruction: extra.instruction || 'Rehacer la actividad', operation: op, status: 'resolved', target: { kind: 'activity', moduleId, title: a.title, chapterNumber: a.placement.chapterNumber }, rawTarget: null, details: extra.details || {}, questions: [], reason: null };
  };
  // Fuente de la BASE del v3 A-S (lo que el servicio trae de los artifacts del run): markdown por capítulo + Context
  // Package armado con el MISMO constructor del ejecutor (dynBuildContextPackage) sobre un plan de conceptos válido.
  const sbx = EX.createExecutorSandbox({ api: async () => { throw { fatal: true, msg: 'no' }; }, artifactText: async () => null, ownerId: 'x', logger: { log() {}, warn() {}, error() {} } });
  const invAS = await inventoryOf(AS);
  const outline = SIM.input.blueprint.modules.map((m) => ({ id: m.id, title: m.title, objective: m.objective ?? null, chapters: m.chapters.map((c) => ({ id: c.id, title: c.title, objective: c.objective ?? null })) }));
  const plan = { modules: Object.fromEntries(outline.map((m) => [m.id, { summary: `Resumen del ${m.title}.` }])), chapters: Object.fromEntries(outline.flatMap((m) => m.chapters.map((c) => [c.id, { summary: `Resumen de ${c.title}.`, concepts_introduced: [c.title], concepts_assumed: [], key_terms: [c.title] }]))) };
  const manifestCp = { course: { title: SIM.input.blueprint.course?.title ?? invAS.course.title, objective: null }, modules: outline };
  const dbAS = { chapterMd: new Map(), contextPackage: new Map(), courseContext: { nombre: invAS.course.title, sector: 'Servicios', pais: 'Colombia' } };
  for (const ch of invAS.chapters) {
    const id = ch.builderUuid;
    if (!id) continue;
    const md = SIM.input.contents.contentMd.get(id);
    if (md) dbAS.chapterMd.set(ch.number, md);
    dbAS.contextPackage.set(ch.number, sbx.ctx.dynBuildContextPackage(manifestCp, dbAS.courseContext, plan, id).contextPackage);
  }
  const V3 = { practice: 1020, video: 1017, gamma: 1014, welcome: 1001, audiobook: 1010 };
  const V1M = { scorm: 912, video: 911, audiobook: 902 };
  const produceOne = async (buf, op, mid, o = {}) => {
    const ctx = await ctxOf(buf, o.db || null);
    const prov = SIMLIB.simProviders(DIST, o.sim || {});
    const gate = SIMLIB.memGate(DIST, { capUsd: o.capUsd ?? 20 });
    const req = reqFor(ctx, op, mid, o.req || {});
    const prep = await B.prepareRegenItem(ctx, req, { providers: prov, gate, spent: gate.spent });
    return { ctx, prov, gate, req, prep };
  };
  const applyOps = (buf, items) => A.runApply({ original: buf, expectedSha1: sha('sha1', buf), filename: 'curso.mbz', items: items.map((p, i) => ({ id: `i${i}`, requestId: `r${i}`, operation: p.op, quote: 'q', summary: `ítem ${i}`, params: p })) });
  const withProduced = (prep) => ({ ...prep.view.params, produced: prep.produced });
  const results = {};

  await check('G0 red y SDK bloqueados: un intento de salir falla y se cuenta; el simulador no los usa', async () => {
    let threw = false;
    try { await fetch('https://api.gamma.app'); } catch { threw = true; }
    assert(threw && REAL.fetch === 1, 'fetch bloqueado y contado');
    REAL.fetch = 0;
    const p = SIMLIB.simProviders(DIST);
    assert(p.simulated === true && p.config.missing.length === 0, 'simulados');
  });

  await check('R0 marcas de mecánica del juego: cada clase sale SOLO del renderizador de su plantilla (ejecutor vendorizado)', async () => {
    const ids = vm.runInContext('SCORM_V2_TEMPLATES.map(function(t){return t.id})', sbx.ctx);
    eq([...ids].sort(), Object.keys(TG.SCORM_V2_ROOM_MARKERS).sort(), 'una marca por plantilla');
    const fx = JSON.parse(vm.runInContext('JSON.stringify(SV2_PREVIEW_FIXTURES)', sbx.ctx));
    for (const id of ids) {
      const html = sbx.ctx.SV2_ROOM_RENDERERS[id].html(fx[id]);
      for (const [other, cls] of Object.entries(TG.SCORM_V2_ROOM_MARKERS)) {
        const has = new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`).test(html);
        assert(has === (other === id), `${cls} en la sala ${id}: ${has}`);
      }
    }
    const full = sbx.ctx.buildScormV2Html({ n: 1, t: 'Cap' }, ['crucigrama', 'multicamino', 'sopa_letras', 'equipar_escena', 'ruleta_preguntas'], ['crucigrama', 'multicamino', 'sopa_letras', 'equipar_escena', 'ruleta_preguntas'].map((id) => ({ templateId: id, data: fx[id] })));
    eq(TG.scormV2Rooms(full), ['crucigrama', 'multicamino', 'sopa_letras', 'equipar_escena', 'ruleta_preguntas'], 'mecánicas leídas del HTML del motor, sala por sala');
  });

  await check('R1 plan: estimado POR PROVEEDOR (estimator + catálogo) para cada operación, v3 y V1; no disponible con motivo', async () => {
    const cases = [
      [AS, 'regenerate_scorm', V3.practice, ['anthropic'], dbAS, ['activity']],
      [AS, 'regenerate_video', V3.video, ['videogen', 'youtube', 'anthropic'], null, ['video', 'video_interactions']],
      [AS, 'regenerate_gamma', V3.gamma, ['gamma'], null, ['presentation']],
      [AS, 'regenerate_audio', V3.welcome, ['openai'], null, ['audio_welcome']],
      [AS, 'regenerate_audio', V3.audiobook, ['anthropic', 'openai'], dbAS, ['audiobook_chapter']],
      [V1, 'regenerate_scorm', V1M.scorm, ['anthropic'], null, ['scorm']],
      [V1, 'regenerate_video', V1M.video, ['videogen', 'youtube', 'anthropic'], null, ['video', 'video_interactions']],
      [V1, 'regenerate_audio', V1M.audiobook, ['anthropic', 'openai'], null, ['audiobook_chapter']],
    ];
    for (const [buf, op, mid, provs, db, types] of cases) {
      const ctx = await ctxOf(buf, db);
      const call = await B.estimateContent(ctx, reqFor(ctx, op, mid));
      assert(call && call.kind === 'regenerate', `${op} ${mid}: ${JSON.stringify(call).slice(0, 200)}`);
      eq(call.regen.providers.map((l) => l.provider), provs, `${op} ${mid}: proveedores`);
      const tl = call.regen.providers.reduce((s, l) => s + Number(l.boundUsd), 0);
      assert(Math.abs(tl - Number(call.regen.totalBoundUsd)) < 1e-6, 'Σ cotas');
      // Estimado = estimator directo con los mismos items del generador.
      const lines = EST.estimateCost({ items: types.map((t, k) => ({ itemKey: `k${k}`, itemType: t, action: 'REGENERATE' })), catalog: PRICING.catalog, usageModel: UM.usageModelPriorsV1(), retryPolicy: PRICING.retryPolicy });
      if (!/audio/.test(op)) eq(call.expectedUsd, lines.totals.expected, `${op}: esperado = estimator`);
      for (const l of call.regen.providers) assert(l.what && Number(l.expectedUsd) >= 0, 'línea con qué y cuánto');
      const view = B.estimateItemView(ctx, reqFor(ctx, op, mid), call);
      assert(view.generated === false && view.plannedCall === call && /proveedor/.test(view.cost.basis) && view.cost.contentEstimate.expected === call.expectedUsd, `${op}: vista de estimado`);
      const cap = Number(PL.proposedCapOf([call]).proposedCapUsd);
      assert(cap + 1e-9 >= Number(call.regen.totalBoundUsd) && cap > 0, `${op}: tope propuesto ${cap} ≥ Σ cotas ${call.regen.totalBoundUsd}`);
      results[`est:${op}:${mid}`] = { expected: call.expectedUsd, bound: call.regen.totalBoundUsd, cap, providers: call.regen.providers.map((l) => `${l.provider}:${l.calls}:${Number(l.expectedUsd).toFixed(3)}`) };
    }
    // No disponibles, con motivo (y sin gastar): V1 sin presentación; práctica v3 sin Context Package; audiolibro sin fuente.
    const v1 = await ctxOf(V1);
    const g = await B.estimateContent(v1, reqFor(v1, 'regenerate_gamma', 904));
    assert(g && g.unavailable && /presentación/.test(g.unavailable), `V1 sin Gamma: ${JSON.stringify(g)}`);
    const as0 = await ctxOf(AS);
    const p = await B.estimateContent(as0, reqFor(as0, 'regenerate_scorm', V3.practice));
    assert(p && /Context Package/.test(p.unavailable || ''), 'práctica sin la fuente de Cursia → no disponible');
    const v1short = await ctxOf(V1base);
    const ab = await B.estimateContent(v1short, reqFor(v1short, 'regenerate_audio', V1M.audiobook));
    assert(ab && /capítulos 1, 2/.test(ab.unavailable || ''), `audiolibro sin texto de los capítulos → no disponible: ${JSON.stringify(ab)}`);
    const rv = await B.estimateContent(as0, reqFor(as0, 'regenerate_scorm', 1021));
    assert(rv && /Repaso/.test(rv.unavailable || ''), 'el Repaso (Dialogcards) no es una práctica rehacible');
  });

  await check('R2 sin aprobación → 0 llamadas: estimar no llama; prepareItem no produce; con tope 0 corta ANTES de la primera llamada', async () => {
    const prov = SIMLIB.simProviders(DIST);
    const ctx = await ctxOf(AS, dbAS);
    for (const [op, mid] of [['regenerate_video', V3.video], ['regenerate_gamma', V3.gamma], ['regenerate_audio', V3.audiobook]]) {
      await B.estimateContent(ctx, reqFor(ctx, op, mid));
      const p = await B.prepareItem(ctx, reqFor(ctx, op, mid), async () => { throw new Error('no debe llamar a la IA'); });
      eq(p.status, 'failed', `${op}: prepareItem no produce`);
    }
    for (const [buf, op, mid, db] of [[V1, 'regenerate_scorm', V1M.scorm, null], [AS, 'regenerate_video', V3.video, null], [AS, 'regenerate_gamma', V3.gamma, null], [AS, 'regenerate_audio', V3.audiobook, dbAS], [AS, 'regenerate_scorm', V3.practice, dbAS]]) {
      let err = null;
      const c = await ctxOf(buf, db);
      const gate = SIMLIB.memGate(DIST, { capUsd: 0 });
      try { await B.prepareRegenItem(c, reqFor(c, op, mid), { providers: prov, gate, spent: gate.spent }); } catch (e) { err = e; }
      assert(err && err.code === 'cap_reached', `${op}: tope 0 → cap_reached (${err && err.message})`);
      eq(gate.calls.length, 0, `${op}: ninguna llamada registrada`);
    }
    const n = Object.entries(prov.calls).reduce((s, [k, v]) => s + (Array.isArray(v) ? v.length : v), 0);
    eq(n, 0, 'el simulador no recibió ninguna llamada');
  });

  const okRun = async (label, buf, items, check2) => {
    const res = await applyOps(buf, items);
    assert(res.ok, `${label}: ${JSON.stringify({ stage: res.stage, code: res.code, message: res.message, introduced: res.diagnosis && res.diagnosis.introduced }).slice(0, 600)}`);
    eq(res.diagnosis.introduced, [], `${label}: sin hallazgos nuevos`);
    eq(res.validation.introduced, [], `${label}: validador sin problemas nuevos`);
    if (check2) await check2(res);
    return res;
  };
  const blobOf = async (buf, mid, area, re) => { const inv = await inventoryOf(buf); const a = inv.activities.find((x) => x.moduleId === mid); const f = a.files.find((x) => x.filearea === area && re.test(x.filename)); const pkg = await R.openMbz(buf); return { f, data: f ? await pkg.readEntry(f.blobEntry) : null, a }; };
  const field = async (buf, mid, fname = 'intro') => (await inventoryOf(buf)).activities.find((x) => x.moduleId === mid).html.find((h) => h.field === fname).html;

  const prods = {};
  await check('R3a V1 · juego SCORM: 5 salas del motor v2, index + manifiesto, scoes en su rango; aplicado sin hallazgos nuevos', async () => {
    const r = await produceOne(V1, 'regenerate_scorm', V1M.scorm);
    assert(r.prep.status === 'resolved', `${r.prep.status}: ${r.prep.reason}`);
    prods.v1scorm = r;
    eq(r.gate.calls.map((c) => [c.provider, c.status]), Array.from({ length: 5 }, () => ['anthropic', 'charged']), '5 llamadas cobradas (una por sala)');
    assert(r.gate.charges.every((c) => c.mode === 'mock' && c.metadata.approvalId && c.operation === 'llm.workshop_regenerate'), 'cargos simulados con approvalId');
    eq(r.prep.view.regen.after.rooms, 5, 'después: 5 salas');
    assert(/rotación/.test(r.prep.view.regen.notes.join(' ')), 'el juego viejo no es del motor v2: lo dice');
    await okRun('V1 scorm', V1, [withProduced(r.prep)], async (res) => {
      const { data } = await blobOf(res.package, V1M.scorm, 'content', /^index\.html$/);
      eq(TG.scormV2Rooms(data.toString()).length, 5, 'index.html nuevo con 5 salas');
      const pkg = await R.openMbz(res.package);
      const sx = (await pkg.readEntry(`activities/scorm_${V1M.scorm}/scorm.xml`)).toString();
      const ids = [...sx.matchAll(/<sco(?:_data)? id="(\d+)">/g)].map((m) => Number(m[1]));
      assert(ids.length === 4 && ids.every((x) => x >= 60000) && new Set(ids).size === 4, `sco / sco_data en su rango: ${ids}`);
      assert(/<identifier>cap1_org<\/identifier>/.test(sx) && /<launch>index\.html<\/launch>/.test(sx), 'scoes según el manifiesto nuevo');
      results.v1scorm = { sha1: res.sha1, files: res.items[0].files.map((f) => f.filename) };
    });
  });

  await check('R3b V1 · SCORM con «⚠️ Pendiente» (falla sembrada de B0) → rehecho; el hallazgo T06 queda resuelto', async () => {
    const BC = require(path.join(REPO, 'scripts/r107/build-corpus.js'));
    const z = await JSZip.loadAsync(V1);
    const exp = await BC.MUTATIONS['scorm-pending'](z);
    assert(exp, 'mutación');
    const dmg = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const r = await produceOne(dmg, 'regenerate_scorm', V1M.scorm);
    assert(r.prep.status === 'resolved', r.prep.reason);
    assert(r.prep.view.regen.before.pending === true, 'antes: con «Pendiente»');
    const res = await okRun('V1 scorm pendiente', dmg, [withProduced(r.prep)]);
    assert(res.diagnosis.resolved.some((x) => /T06\|scorm_pending/.test(x.signature)), `T06 resuelto: ${JSON.stringify(res.diagnosis.resolved.map((x) => x.signature))}`);
  });

  await check('R3c V1 · video hvp: render + YouTube + preguntas desde el guion nuevo → json_content nuevo; sin hallazgos nuevos', async () => {
    const r = await produceOne(V1, 'regenerate_video', V1M.video);
    assert(r.prep.status === 'resolved', r.prep.reason);
    eq(r.gate.calls.map((c) => [c.provider, c.status]), [['videogen', 'charged'], ['youtube', 'charged'], ['anthropic', 'charged']], 'render → YouTube → preguntas');
    const after = r.prep.view.regen.after;
    assert(after.youtubeId === 'SimVideo001' && after.interactions >= 1 && after.scenes === 8 && /Escena 1/.test(after.script), `guion y preguntas: ${JSON.stringify(after).slice(0, 200)}`);
    await okRun('V1 video', V1, [withProduced(r.prep)], async (res) => {
      const x = (await (await R.openMbz(res.package)).readEntry(`activities/hvp_${V1M.video}/hvp.xml`)).toString();
      const j = JSON.parse(FX.xmlUnesc(/<json_content>([\s\S]*?)<\/json_content>/.exec(x)[1]));
      assert(/SimVideo001/.test(j.interactiveVideo.video.files[0].path), 'video nuevo');
      assert(j.interactiveVideo.assets.interactions.length >= 1, 'preguntas');
    });
  });

  await check('R3d V1 · audiolibro: TODOS los capítulos narrados por bloques (validación de palabras) + voz → MP3 nuevo; sin hallazgos nuevos', async () => {
    const r = await produceOne(V1, 'regenerate_audio', V1M.audiobook);
    assert(r.prep.status === 'resolved', r.prep.reason);
    eq(r.prep.view.regen.after.chapters.map((c) => c.number), [1, 2], 'capítulos 1 y 2');
    assert(r.gate.calls.filter((c) => c.provider === 'anthropic').length >= 2 && r.gate.calls.filter((c) => c.provider === 'openai').length >= 2, 'guion + voz');
    await okRun('V1 audiolibro', V1, [withProduced(r.prep)], async (res) => {
      const { data } = await blobOf(res.package, V1M.audiobook, 'intro', /\.mp3$/);
      assert(Math.abs(AUD.mp3DurationSeconds(data) - r.prep.produced.durationSec) < 0.5, 'el MP3 del paquete es el producido');
    });
  });

  await check('R3e v3 · práctica H5P (questionset) con la fuente de Cursia → mismo tipo, .h5p del builder; sin hallazgos nuevos', async () => {
    const r = await produceOne(AS, 'regenerate_scorm', V3.practice, { db: dbAS });
    assert(r.prep.status === 'resolved', r.prep.reason);
    eq([r.prep.view.regen.before.h5pType, r.prep.view.regen.after.h5pType, r.prep.view.regen.after.mainLibrary], ['questionset', 'questionset', 'H5P.QuestionSet'], 'mismo tipo');
    prods.practice = r;
    await okRun('v3 práctica', AS, [withProduced(r.prep)]);
  });

  await check('R3f v3 · video H5P: .h5p nuevo + enlace de YouTube de la descripción actualizado; sin hallazgos nuevos', async () => {
    const r = await produceOne(AS, 'regenerate_video', V3.video);
    assert(r.prep.status === 'resolved', r.prep.reason);
    prods.video = r;
    eq(r.prep.view.regen.before.youtubeId, 'IdwOipZAeqY', 'antes');
    await okRun('v3 video', AS, [withProduced(r.prep)], async (res) => {
      const intro = await field(res.package, V3.video);
      assert(intro.includes('watch?v=SimVideo001') && !intro.includes('IdwOipZAeqY'), 'enlace de YouTube nuevo en la descripción');
    });
  });

  await check('R3g v3 · presentación de Gamma: es-419, PDF + portada rasterizada, «(PDF, 10 diapositivas)»; sin hallazgos nuevos', async () => {
    const r = await produceOne(AS, 'regenerate_gamma', V3.gamma);
    assert(r.prep.status === 'resolved', r.prep.reason);
    prods.gamma = r;
    eq(r.prov.calls.gamma.find((c) => c.op === 'create').language, 'es-419', 'idioma pedido');
    eq(r.prov.calls.raster, 1, 'portada rasterizada (página 1)');
    eq([r.prep.view.regen.before.slides, r.prep.view.regen.after.slideCount], [8, 10], 'diapositivas antes / después');
    await okRun('v3 gamma', AS, [withProduced(r.prep)], async (res) => {
      assert((await field(res.package, V3.gamma)).includes('(PDF, 10 diapositivas)'), 'texto de diapositivas actualizado');
    });
  });

  await check('R3h v3 · audio de bienvenida y audiolibro (9 capítulos) → MP3 mono ≤ 64 kbps, duración del texto actualizada; sin hallazgos nuevos', async () => {
    const w = await produceOne(AS, 'regenerate_audio', V3.welcome);
    assert(w.prep.status === 'resolved', w.prep.reason);
    eq(w.gate.calls.every((c) => c.provider === 'openai'), true, 'bienvenida: solo voz (sin IA)');
    const b = await produceOne(AS, 'regenerate_audio', V3.audiobook, { db: dbAS });
    assert(b.prep.status === 'resolved', b.prep.reason);
    eq(b.prep.view.regen.after.chapters.map((c) => c.number), invAS.chapters.map((c) => c.number), 'todos los capítulos');
    assert(b.prep.view.regen.after.channels === 1 && b.prep.view.regen.after.bitrateKbps <= 64, 'mono ≤ 64 kbps');
    prods.welcome = w; prods.audiobook = b;
    await okRun('v3 audios', AS, [withProduced(w.prep), withProduced(b.prep)], async (res) => {
      const t = await field(res.package, V3.audiobook);
      const dur = AUD.formatDurationEs(b.prep.produced.durationSec);
      assert(t.includes(`Duración total: ${dur}`), `duración del audiolibro en el texto (${dur})`);
    });
  });

  await check('R3i plan COMBINADO v3 (práctica + video + Gamma + bienvenida + audiolibro) en una versión; determinista', async () => {
    const items = ['practice', 'video', 'gamma', 'welcome', 'audiobook'].map((k) => withProduced(prods[k].prep));
    const r1 = await okRun('v3 combinado', AS, items);
    const r2 = await applyOps(AS, items);
    eq(r2.sha1, r1.sha1, 'mismo plan → mismos bytes');
    eq(r1.items.map((x) => x.operation), ['regenerate_scorm', 'regenerate_video', 'regenerate_gamma', 'regenerate_audio', 'regenerate_audio'], 'un informe por ítem');
    results.v3combined = { sha1: r1.sha1, bytes: r1.package.length };
  });

  await check('R4 resultado inválido NUNCA se aplica (generador y motor)', async () => {
    // a) el generador no logra una sala válida → no hay resultado (nada que aplicar), motivo visible
    const a = await produceOne(V1, 'regenerate_scorm', V1M.scorm, { sim: { fault: { scormRoom: 'invalid' } } });
    assert(a.prep.status === 'failed' && !a.prep.produced && /sala 1/.test(a.prep.reason), `sala inválida: ${a.prep.status} ${a.prep.reason}`);
    assert(a.prep.failure && a.prep.failure.retryable, 'reaprobable');
    // b) resultado alterado: «⚠️ Pendiente» / una sala de menos → el motor lo rechaza
    const good = withProduced(prods.v1scorm.prep);
    const pend = { ...good, produced: { ...good.produced, html: good.produced.html.replace('<div class="sv2-shell">', '<div class="sv2-shell"><p>⚠️ Pendiente: sala</p>') } };
    const r1 = await applyOps(V1, [pend]);
    assert(!r1.ok && r1.code === 'WORKSHOP_APPLY_INVALID_CONTENT' && /Pendiente/.test(r1.message) && !r1.package, `pendiente: ${r1.code} ${r1.message}`);
    const fewer = { ...good, produced: { ...good.produced, html: good.produced.html.replace(/<div class="sv2-room" id="sv2-room-4"[\s\S]*?(?=<\/div><div class="sv2-panel" id="sv2-report")/, '') } };
    const r2 = await applyOps(V1, [fewer]);
    assert(!r2.ok && /sala/.test(r2.message), `salas de menos: ${r2.message}`);
    // c) audiolibro sin un capítulo
    const ab = withProduced(prods.audiobook.prep);
    const r3 = await applyOps(AS, [{ ...ab, produced: { ...ab.produced, chapters: ab.produced.chapters.filter((c) => c.number !== 3) } }]);
    assert(!r3.ok && /faltan los capítulos 3/.test(r3.message), `audiolibro sin el capítulo 3: ${r3.message}`);
    // d) guion corto en un capítulo → la producción corta (no hay audiolibro con capítulos de menos)
    const d = await produceOne(AS, 'regenerate_audio', V3.audiobook, { db: dbAS, sim: { fault: { narrationShort: 3 } } });
    assert(d.prep.status === 'failed' && !d.prep.produced && /capítulo 3/.test(d.prep.reason), `guion corto: ${d.prep.reason}`);
    // e) video sin preguntas: el generador lo rechaza; un .h5p alterado sin preguntas, el motor
    const e = await produceOne(AS, 'regenerate_video', V3.video, { sim: { fault: { vintNoQuestions: true } } });
    assert(e.prep.status === 'failed' && !e.prep.produced, `video sin preguntas: ${e.prep.reason}`);
    const vid = withProduced(prods.video.prep);
    const z = await JSZip.loadAsync(vid.produced.h5p);
    const cj = JSON.parse(await z.file('content/content.json').async('string'));
    cj.interactiveVideo.assets.interactions = [];
    z.file('content/content.json', JSON.stringify(cj));
    const r4 = await applyOps(AS, [{ ...vid, produced: { ...vid.produced, h5p: await z.generateAsync({ type: 'nodebuffer' }) } }]);
    assert(!r4.ok && /no tiene preguntas/.test(r4.message), `video sin preguntas en el motor: ${r4.message}`);
    // f) sin resultado cargado → no se aplica nada
    const r5 = await applyOps(V1, [{ ...good, produced: null }]);
    assert(!r5.ok && /resultado producido/.test(r5.message), r5.message);
  });

  await check('R5 llamada ambigua → sin reenvío automático, cota como gastada, reserva PENDIENTE; rechazos sin cobro; YouTube sin conexión → 0 gasto', async () => {
    let err = null;
    let r = null;
    try { r = await produceOne(AS, 'regenerate_gamma', V3.gamma, { sim: { fault: { gammaCreate: 'ambiguous' } } }); } catch (e) { err = e; }
    assert(err && err.code === 'call_ambiguous', `Gamma 502: ${err && err.code}`);
    // reconstruimos la compuerta para mirar lo registrado (produceOne no devolvió)
    const ctx = await ctxOf(AS);
    const prov = SIMLIB.simProviders(DIST, { fault: { gammaCreate: 'ambiguous' } });
    const gate = SIMLIB.memGate(DIST, { capUsd: 5 });
    await B.prepareRegenItem(ctx, reqFor(ctx, 'regenerate_gamma', V3.gamma), { providers: prov, gate, spent: gate.spent }).catch((e) => e);
    eq(prov.calls.gamma.filter((c) => c.op === 'create').length, 1, 'un solo envío: no se reenvía');
    eq(gate.calls.map((c) => c.status), ['ambiguous'], 'llamada ambigua registrada');
    assert(Math.abs(gate.spentUsd - Number(gate.calls[0].boundUsd)) < 1e-9, 'la cota cuenta como gastada');
    const calls = Object.fromEntries(gate.calls.map((c) => [c.id, { id: c.id, kind: c.kind, attempt: 1, boundUsd: c.boundUsd, status: c.status, at: 'x' }]));
    const settled = [];
    const close = await AL.closeReservation({ recordCharge: async () => ({}), settleReservation: async (k) => { settled.push(k); } }, { reservationKey: 'workshop:approval:x', calls }, 'test');
    eq([close.reservation, settled.length], ['pending', 0], 'reserva pendiente (no se libera)');
    // render que no termina → ambiguo; ni YouTube ni la IA se llaman después
    const v = SIMLIB.simProviders(DIST, { fault: { videogenRender: 'timeout' }, pollTimeoutMs: 30 });
    const vg = SIMLIB.memGate(DIST, { capUsd: 5 });
    const vctx = await ctxOf(AS);
    const ve = await B.prepareRegenItem(vctx, reqFor(vctx, 'regenerate_video', V3.video), { providers: v, gate: vg, spent: vg.spent }).catch((e) => e);
    assert(ve && ve.code === 'call_ambiguous', `render sin terminar: ${ve && ve.code}`);
    eq([v.calls.videogen.filter((c) => c.op === 'create').length, v.calls.youtube.length, v.calls.anthropic.length], [1, 0, 0], 'un render, sin YouTube ni IA');
    eq(vg.calls.map((c) => [c.provider, c.status, c.externalId]), [['videogen', 'ambiguous', 'vg_sim_1']], 'ambiguo con el id del job (para conciliar)');
    // TTS 429 → sin cobro (rechazo documentado); 502 → ambiguo
    for (const [st, want, code] of [[429, 'not_charged', 'provider_rejected'], [502, 'ambiguous', 'call_ambiguous']]) {
      const p = SIMLIB.simProviders(DIST, { fault: { ttsStatus: st } });
      const g = SIMLIB.memGate(DIST, { capUsd: 5 });
      const c = await ctxOf(AS);
      const x = await B.prepareRegenItem(c, reqFor(c, 'regenerate_audio', V3.welcome), { providers: p, gate: g, spent: g.spent }).catch((e) => e);
      assert(x && x.code === code, `TTS ${st}: ${x && x.code}`);
      eq(g.calls.map((k) => k.status), [want], `TTS ${st}: ${want}`);
      eq(p.calls.openai.length, 1, `TTS ${st}: sin reintento automático`);
    }
    // YouTube desconectado → ANTES de pagar el render
    const y = SIMLIB.simProviders(DIST, { fault: { youtube: 'disconnected' } });
    const yg = SIMLIB.memGate(DIST, { capUsd: 5 });
    const yc = await ctxOf(AS);
    const ye = await B.prepareRegenItem(yc, reqFor(yc, 'regenerate_video', V3.video), { providers: y, gate: yg, spent: yg.spent }).catch((e) => e);
    assert(ye && ye.code === 'provider_not_ready' && /render/.test(ye.message), `YouTube desconectado: ${ye && ye.message}`);
    eq(yg.calls.length, 0, '0 llamadas pagadas');
    // sin pdftoppm / ffmpeg → antes de gastar
    for (const [f, op, mid] of [['raster', 'regenerate_gamma', V3.gamma], ['ffmpeg', 'regenerate_audio', V3.welcome]]) {
      const p = SIMLIB.simProviders(DIST, { fault: { [f]: 'missing' } });
      const g = SIMLIB.memGate(DIST, { capUsd: 5 });
      const c = await ctxOf(AS);
      const x = await B.prepareRegenItem(c, reqFor(c, op, mid), { providers: p, gate: g, spent: g.spent }).catch((e) => e);
      assert(x && x.code === 'provider_not_ready' && g.calls.length === 0, `${f} faltante → nada pagado`);
    }
  });

  await check('R6 D7: rehacer el video avisa del Libro y de las preguntas del examen del capítulo (no se agregan solos)', async () => {
    const view = prods.video.prep.view;
    const kinds = view.misalignment.map((w) => [w.kind, w.suggestedOperation, w.activity && w.activity.modname]);
    assert(view.misalignment.some((w) => /Libro Guía/.test(w.message)), `aviso del Libro: ${JSON.stringify(kinds)}`);
    assert(view.misalignment.some((w) => /examen|pregunta/i.test(w.message) && w.activity && w.activity.modname === 'quiz'), 'aviso del examen');
    assert(view.misalignment.every((w) => !w.suggestedOperation || w.estimate), 'con su costo como pedido aparte');
    const ctx = await ctxOf(AS);
    const est = B.estimateItemView(ctx, reqFor(ctx, 'regenerate_video', V3.video), await B.estimateContent(ctx, reqFor(ctx, 'regenerate_video', V3.video)));
    assert(est.misalignment.length >= 1, 'el aviso se ve ANTES de aprobar el gasto');
    eq(prods.gamma.prep.view.misalignment.filter((w) => w.kind === 'same_chapter').length, 0, 'Gamma no avisa del examen (no cambia lo que se evalúa)');
  });

  await check('R7 motor e invariantes: precondición vencida, resultado ajeno, ids sco, artifact con huella, catálogo', async () => {
    const good = withProduced(prods.v1scorm.prep);
    const r1 = await applyOps(V1, [{ ...good, expect: { contenthashes: ['0'.repeat(40)] } }]);
    assert(!r1.ok && r1.code === 'WORKSHOP_APPLY_STALE_TARGET', r1.code);
    const r2 = await applyOps(V1, [{ ...good, moduleId: 922 }]);
    assert(!r2.ok && /otra actividad/.test(r2.message), r2.message);
    // un SCORM con 3 sco: los ids nuevos en el rango 60000+, sin repetir ninguno del paquete
    const z3 = await FX.zipEdit(V1, async (z) => {
      const p = `activities/scorm_${V1M.scorm}/scorm.xml`;
      const x = await z.file(p).async('string');
      z.file(p, x.replace('</scoes>', '<sco id="60099"><manifest>x</manifest><organization>o</organization><parent>o</parent><identifier>extra</identifier><launch>x.html</launch><scormtype>sco</scormtype><title>x</title></sco></scoes>'));
    });
    const r3 = await applyOps(z3, [good]);
    assert(r3.ok, r3.message);
    const sx = (await (await R.openMbz(r3.package)).readEntry(`activities/scorm_${V1M.scorm}/scorm.xml`)).toString();
    const ids = [...sx.matchAll(/<sco(?:_data)? id="(\d+)">/g)].map((m) => Number(m[1]));
    assert(ids.length === 4 && ids.every((x) => x >= 60000) && new Set(ids).size === 4, `ids: ${ids}`);
    const others = [...(await (await R.openMbz(r3.package)).readEntry(`activities/scorm_${922}/scorm.xml`)).toString().matchAll(/<sco(?:_data)? id="(\d+)">/g)].map((m) => Number(m[1]));
    assert(ids.every((x) => !others.includes(x)), 'no repite ids de otro SCORM');
    // artifact: zip determinista, ida y vuelta y huella
    const enc = await BU.encodeProduced(prods.gamma.prep.produced);
    eq(BU.sha256Hex(await BU.encodeProduced(prods.gamma.prep.produced)), BU.sha256Hex(enc), 'determinista');
    const dec = await BU.decodeProduced(enc);
    assert(Buffer.isBuffer(dec.pdf) && dec.pdf.equals(prods.gamma.prep.produced.pdf) && dec.slideCount === 10, 'ida y vuelta');
    const zz = await JSZip.loadAsync(enc);
    zz.file('bin/pdf', Buffer.from('%PDF-otro'));
    let bad = null;
    try { await BU.decodeProduced(await zz.generateAsync({ type: 'nodebuffer' })); } catch (e) { bad = e; }
    assert(bad && /huella/.test(bad.message), 'un binario alterado no se acepta');
    // la vista del ítem NO guarda los bytes (params sin `produced`)
    assert(!('produced' in prods.gamma.prep.view.params) && JSON.stringify(prods.gamma.prep.view).length < 200_000, 'params sin binarios');
    // catálogo: rehacer = Fase 3 (resuelto), agregar capítulo sigue en fase posterior
    eq([...PL.PHASE3_OPERATIONS], ['regenerate_scorm', 'regenerate_video', 'regenerate_gamma', 'regenerate_audio'], 'Fase 3');
    eq([...PL.LATER_OPERATIONS], ['add_chapter', 'add_module'], 'fase posterior');
    const ctx = await ctxOf(V1);
    const out = await PL.interpretText(ctx, 'Rehace el juego del capítulo 1 como una sopa de letras.', async (call) => ({ result: { input: { requests: [{ quote: 'Rehace el juego del capítulo 1 como una sopa de letras.', operation: 'regenerate_scorm', instruction: 'Rehacer el juego como sopa de letras.', target: { chapterNumber: 1 }, targetEvidence: 'el juego del capítulo 1', changeEvidence: 'como una sopa de letras' }] }, stopReason: 'tool_use', model: 'claude-sonnet-4-6', messageId: 'm1', usage: { input_tokens: 10, output_tokens: 10 }, simulated: true }, costUsd: '0' }));
    eq(out.requests.map((r) => [r.status, r.operation, r.target && r.target.moduleId]), [['resolved', 'regenerate_scorm', V1M.scorm]], 'interpretado y resuelto');
    const est = await B.estimateContent(ctx, out.requests[0]);
    assert(/sopa_letras/.test(est.regen.notes.join(' ')), `mecánica pedida: ${est.regen.notes.join(' ')}`);
  });

  await check('R8 Libro v3 (PDF) en el plan: con la fuente del curso → la IA reescribe el MARKDOWN del capítulo, el builder rearma el PDF (reproducción byte a byte), prueba en seco y versión; sin fuente → no disponible; resolvedor del servidor: alcance y procedencia', async () => {
    const LV = L('modules/course-workshop/apply/libro-v3.js');
    const PP = L('modules/dynamic-packaging/packaging-plan-v3.js');
    const input = SIM.input;
    const pl = PP.buildPackagingPlanV3(input.manifest, input.blueprint, { manifestId: input.manifestId ?? null, omitVideoChapterIds: input.pendingVideoChapterIds ?? [] });
    const byNum = new Map(pl.modules.flatMap((m) => m.chapters.filter((c) => c.kind !== 'practice').map((c) => [c.chapterNumber, c.chapterId])));
    const ctx = await ctxOf(AS);
    let loads = 0;
    ctx.libroV3Loader = async () => { loads++; return { buildInput: input, chapterIdByNumber: byNum }; };
    const libro = invAS.activities.find((a) => a.kind === 'libro' && a.modname === 'resource');
    const req = { quote: 'En el capítulo 2 del Libro Guía agrega un párrafo de cierre.', instruction: 'Agregar un párrafo de cierre al capítulo 2 del Libro Guía.', operation: 'edit_libro_section', status: 'resolved', target: { kind: 'libro', moduleId: libro.moduleId, chapters: [2], title: libro.title, recompose: false, pdf: true }, rawTarget: null, details: {}, questions: [], reason: null };
    const est = await B.estimateContent(ctx, req);
    assert(est && est.kind === 'content_libro' && Number(est.expectedUsd) > 0, `estimado de la llamada de markdown: ${JSON.stringify(est).slice(0, 200)}`);
    const md2 = input.contents.contentMd.get(byNum.get(2));
    const calls = [];
    const ai = async (call) => {
      calls.push(call);
      const result = { input: { chapters: [{ number: 2, md: `${md2}\n\nPárrafo de cierre agregado por el Taller en 2026.` }] }, stopReason: 'tool_use', model: 'claude-sonnet-4-6', messageId: `m${calls.length}`, usage: { input_tokens: 2000, output_tokens: 1500 }, simulated: true };
      return { result, costUsd: '0.01' };
    };
    const prep = await B.prepareItem(ctx, req, ai);
    assert(prep.status === 'resolved' && prep.view.dryRun.ok, `${prep.status}: ${prep.reason}`);
    eq([calls.length, calls[0].tool.name], [1, 'entregar_capitulos_libro_md'], 'una llamada de markdown');
    const op = prep.view.params;
    assert(op.pdf && op.pdf.base64 && op.libroV3 && op.libroV3.chapters[0].md.includes('Taller en 2026'), 'PDF armado por el builder + markdown aprobado');
    assert(prep.view.changes[0].after.includes('Párrafo de cierre'), 'antes / después del markdown');
    eq(loads, 1, 'la fuente se resuelve una vez por trabajo');
    const res = await applyOps(AS, [op]);
    assert(res.ok && res.diagnosis.introduced.length === 0, `versión: ${res.message}`);
    const nl = await LV.libroPdfOf(res.package);
    assert(nl && nl.sha1 !== (await LV.libroPdfOf(AS)).sha1, 'PDF nuevo en la versión');
    // markdown recortado → reintento con los problemas; HTML → rechazado
    const bad = await B.prepareItem(ctx, req, async (call) => ({ result: { input: { chapters: [{ number: 2, md: '<div>corto</div>' }] }, stopReason: 'tool_use', model: 'claude-sonnet-4-6', messageId: 'x', usage: { input_tokens: 10, output_tokens: 10 }, simulated: true }, costUsd: '0' }));
    assert(bad.status === 'failed' && /recortado|HTML/.test(bad.reason), `markdown inválido: ${bad.reason}`);
    // sin fuente → no disponible (antes de gastar)
    const c0 = await ctxOf(AS);
    const nos = await B.estimateContent(c0, req);
    assert(nos && /PDF/.test(nos.unavailable || ''), 'sin fuente: no disponible');
    // resolvedor del servidor: procedencia y alcance (base falsa)
    const rows = { ses: { identification: { result: { matchedArtifactId: 'a1' } } }, art: { id: 'a1', owner_id: 'o1', job_id: 'j1', type: 'dynamic_mbz', metadata: {} }, course: { id: 7, owner_id: 'o1', institution_id: null }, job: { id: 'j1', owner_id: 'o1', course_id: 7, input_payload: { runId: 'r1', manifestId: 3, blueprintNumber: 1, packageKind: 'final' } } };
    const fakeDs = (over = {}) => ({ query: async (sql) => {
      const r = { ...rows, ...over };
      if (/from public.workshop_sessions/.test(sql)) return r.ses ? [r.ses] : [];
      if (/from public.artifacts/.test(sql)) return r.art ? [r.art] : [];
      if (/from public.courses/.test(sql)) return r.course ? [r.course] : [];
      if (/from public.production_jobs/.test(sql)) return r.job ? [r.job] : [];
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    } });
    const S0 = { id: 's1', ownerId: 'o1', institutionId: null, identifiedCourseId: 7 };
    let mf = 0;
    const deps = (ds) => ({ dataSource: ds, artifacts: {}, manifests: { getById: async () => { mf++; return { id: 99, manifest: { rulesVersion: 3 } }; } }, blueprints: { getByNumberAnySchema: async () => ({ schemaVersion: 2, snapshot: {} }) } });
    const why = async (ds, s = S0) => { const r = await LV.serverLibroV3Resolver(deps(ds)).resolve(s); return r.unavailable || 'ok'; };
    assert(/no está asociado/.test(await why(fakeDs(), { ...S0, identifiedCourseId: null })), 'sin curso');
    assert(/huella exacta/.test(await why(fakeDs({ ses: { identification: { result: { method: 'title' } } } }))), 'identificado por heurística → no');
    assert(/no es un paquete v3/.test(await why(fakeDs({ art: { ...rows.art, type: 'mbz_final' } }))), 'paquete legacy');
    assert(/no es de este curso/.test(await why(fakeDs({ art: { ...rows.art, owner_id: 'otro' } }))), 'paquete de otra cuenta');
    assert(/no es de este curso/.test(await why(fakeDs({ course: { ...rows.course, owner_id: 'otro' } }))), 'curso fuera del alcance');
    assert(/vista previa/.test(await why(fakeDs({ job: { ...rows.job, input_payload: { ...rows.job.input_payload, packageKind: 'qa_preview' } } }))), 'paquete QA');
    assert(/no es el del paquete/.test(await why(fakeDs())) && mf === 1, 'Manifest distinto del del job');
    eq(LV.libroV3ResolverOf(fakeDs(), {}, null), LV.SERVER_LIBRO_V3_RESOLVER, 'sin los servicios del generador → no disponible');
  });

  console.log(`   estimados: ${JSON.stringify(results).slice(0, 1600)}`);
  const real = Object.entries(REAL).filter(([, v]) => v > 0);
  if (real.length) { fail++; console.log(`❌ llamadas REALES intentadas: ${JSON.stringify(REAL)}`); }
  console.log(`\n${fail ? '❌' : '✅'} check-r107-regenerate --ci: ${ok}/${ok + fail} · llamadas reales: anthropic ${REAL.anthropic}, fetch ${REAL.fetch}, http ${REAL.http}, net ${REAL.net}, binarios ${REAL.spawn}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
