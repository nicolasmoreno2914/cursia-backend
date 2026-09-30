#!/usr/bin/env node
/* eslint-disable */
// Cursia R16 — empaque v3: carga de contenidos CONCURRENTE (loadContentsV3).
// Puro: sin DB, sin red (fetch prohibido). Storage falso con demoras.
//
//  - runOrderedWithLimit: orden del resultado = orden de las tareas, nunca más
//    de `limit` en vuelo, rechaza con el error de MENOR índice (el del loop
//    secuencial), no arranca nada tras una falla, absorbe rechazos tardíos;
//  - loadContentsV3 sobre un run REAL completo (texto, MP3 por loadBytes,
//    PDF + portada por loadStorageBytes, avisos de presentación):
//      · con demoras al azar el resultado es IDÉNTICO (contenido, orden de
//        inserción de cada Map, avisos en orden) al de una carga en serie;
//      · hay concurrencia real (> 1 en vuelo) y nunca más de 6;
//      · el .mbz construido con uno y otro es byte a byte el mismo (sha256);
//  - fail fast: una descarga que falla rechaza con SU error y no arranca
//    descargas nuevas; con dos fallas, gana la del orden secuencial aunque la
//    posterior falle antes; un PackagingNotReadyError (video sin YouTube) no se
//    cambia por el error de red de un capítulo posterior.
//
// Usage: node scripts/check-packaging-v3-concurrent-loader.js [path/to/dist]
'use strict';
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv[2] || path.join(ROOT, 'dist'));
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const PK = loadDist('modules/dynamic-packaging/packaging-v3.js');
const OL = loadDist('modules/dynamic-packaging/ordered-limit.js');
const PV3 = loadDist('modules/dynamic-packaging/packaging-plan-v3.js');
const PT = loadDist('modules/dynamic-packaging/packaging-types.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const PRES = loadDist('package/presentation/index.js');
const PF = require('./lib/v21-packaging-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y.slice(0, 400)}, encontrado ${x.slice(0, 400)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Forma comparable de los contenidos: cada Map como lista [clave, valor] EN SU ORDEN de inserción, Buffers por sha.
function canon(v) {
  if (Buffer.isBuffer(v)) return { buf: sha(v), n: v.length };
  if (v instanceof Map) return { map: [...v.entries()].map(([k, x]) => [k, canon(x)]) };
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).map((k) => [k, canon(v[k])]));
  return v;
}

// ── Fixture: run REAL completo (sin mocks) con artifacts servidos por un Storage falso ──
function realRunFixture(engine) {
  const fx = PF.packagingInput(distRoot, { engine, finalExam: true, courseId: 733 });
  const manifest = fx.manifest;
  const OWNER = '11111111-2222-4333-8444-555555555555';
  const RUN_ID = '22222222-1111-4111-8111-111111111111';
  const files = new Map(); // artifactId → Buffer | string
  const storage = new Map(); // storagePath → Buffer
  const rows = [];
  let n = 0;
  const addArt = (item, type, content, mime = 'application/json', outputSummary = {}) => {
    const id = `art-${String(++n).padStart(3, '0')}`;
    files.set(id, content);
    rows.push({ item_key: item.key, item_run_id: `gir-${item.key}`, gir_status: 'completed', gir_type: item.type, output_summary: outputSummary, artifact_id: id, artifact_type: type, storage_bucket: 'cursia-artifacts', storage_path: `${OWNER}/dyn/${id}`, mime_type: mime, artifact_status: null, metadata: {} });
    return id;
  };
  const chapters = manifest.modules.flatMap((m) => m.chapters);
  const chIndex = new Map(chapters.map((c, i) => [c.chapterId, i]));
  for (const item of manifest.items) {
    const ch = item.chapterId;
    switch (item.type) {
      case 'course_plan': addArt(item, 'dynamic_course_plan_json', '{}'); break;
      case 'course_intro': addArt(item, 'dynamic_course_intro_json', JSON.stringify(fx.contents.courseIntro)); break;
      case 'module_intro': addArt(item, 'dynamic_module_intro_json', JSON.stringify(fx.contents.moduleIntros.get(item.moduleId))); break;
      case 'content': {
        const md = fx.contents.contentMd.get(ch);
        // el sha validado por el servidor también se verifica en la carga concurrente
        const id = `art-${String(n + 1).padStart(3, '0')}`;
        addArt(item, 'dynamic_content_md', md, 'text/markdown', { v3Validation: { artifactType: 'dynamic_content_md', artifactId: id, contentSha256: sha(md) } });
        addArt(item, 'dynamic_context_package_json', '{}');
        break;
      }
      case 'experience': addArt(item, 'dynamic_experience_json', JSON.stringify(fx.contents.experiences.get(ch))); break;
      case 'presentation': {
        const i = chIndex.get(ch);
        const p = fx.contents.presentations.get(ch);
        const pdfPath = `${OWNER}/pres/${ch}.pdf`;
        const coverPath = `${OWNER}/pres/${ch}.png`;
        storage.set(pdfPath, p.pdf);
        storage.set(coverPath, p.cover);
        const pages = PRES.pdfPageCount(p.pdf);
        const body = {
          schemaVersion: 1, chapterId: ch, gammaGenerationId: `gen-${ch}`,
          pdf: { storagePath: pdfPath, sha256: sha(p.pdf), bytes: p.pdf.length },
          cover: { storagePath: coverPath, sha256: sha(p.cover), bytes: p.cover.length, width: 1600, height: 900 },
          // capítulos impares: slideCount declarado ≠ páginas → aviso; todos: gammaThemeId viejo → theme_mismatch
          slideCount: i % 2 ? pages + 1 : pages,
          themeFamilyAtGeneration: 'aula-clara', themeModeAtGeneration: 'light', gammaThemeId: 'tema-viejo', generatedAt: '2026-09-01T00:00:00.000Z',
        };
        const errs = PRES.validatePresentationArtifact(body);
        if (errs.length) throw new Error('fixture de presentación inválida: ' + JSON.stringify(errs));
        addArt(item, 'dynamic_presentation', JSON.stringify(body));
        break;
      }
      case 'audio_welcome': addArt(item, 'dynamic_audio_mp3', fx.contents.audioWelcome, 'audio/mpeg'); break;
      case 'audiobook_chapter': addArt(item, 'dynamic_audio_mp3', fx.contents.audiobookChapters.get(ch), 'audio/mpeg'); break;
      case 'video': addArt(item, 'dynamic_video', JSON.stringify({ mode: 'real', delivery: 'youtube', videogenJobId: `vg-${ch}`, youtubeVideoId: PF.YOUTUBE_ID, youtubeUrl: `https://www.youtube.com/watch?v=${PF.YOUTUBE_ID}`, durationSec: PF.VIDEO_SECONDS })); break;
      case 'video_interactions': addArt(item, 'dynamic_video_interactions_json', JSON.stringify(fx.contents.videoInteractions.get(ch))); break;
      case 'activity': {
        const a = fx.contents.activities.get(ch);
        if (a.variant === 'h5p') addArt(item, 'dynamic_h5p_params_json', JSON.stringify(a.payload));
        else { addArt(item, 'dynamic_scorm_html', a.html, 'text/html'); addArt(item, 'dynamic_scorm_manifest', a.manifestXml, 'application/xml'); }
        break;
      }
      case 'exam': addArt(item, 'dynamic_exam_gift', fx.contents.examGift.get(item.moduleId), 'text/plain'); break;
      case 'final_exam': addArt(item, 'dynamic_exam_gift', fx.contents.finalExamGift, 'text/plain'); break;
      default: throw new Error(`tipo sin fixture ${item.type}`);
    }
  }
  const run = { id: RUN_ID, owner_id: OWNER, input_payload: { videoMode: 'real', videoDelivery: 'youtube' } };
  const q = {
    async query(sql) {
      if (/from public\.production_jobs where id = \$1/.test(sql)) return [{ id: RUN_ID, execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed' }];
      if (/generation_item_runs/.test(sql)) return rows;
      throw new Error(`SQL no esperado: ${sql.slice(0, 60)}`);
    },
  };
  return { fx, manifest, run, q, files, storage, OWNER };
}

/**
 * Storage falso: cada carga espera `delay(key)` ms y cuenta cuántas hay en vuelo.
 * `fail(key)` → Error a devolver (tras la demora) en vez del contenido.
 */
function fakeLoaders(f, { delay = () => 0, fail = () => null } = {}) {
  const stats = { inflight: 0, maxInflight: 0, started: [], log: [] };
  const wrap = async (key, get) => {
    stats.started.push({ key, t: Date.now() });
    stats.inflight++;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    try {
      const d = delay(key);
      if (d > 0) await sleep(d);
      const e = fail(key);
      if (e) throw e;
      return get();
    } finally {
      stats.inflight--;
      stats.log.push({ key, t: Date.now() });
    }
  };
  const L = {
    loadText: (a) => wrap(a.artifactId, () => { const v = f.files.get(a.artifactId); return Buffer.isBuffer(v) ? v.toString('utf8') : v; }),
    loadBytes: (a) => wrap(a.artifactId, () => { const v = f.files.get(a.artifactId); return Buffer.isBuffer(v) ? v : Buffer.from(v); }),
    loadStorageBytes: (bucket, p) => wrap(p, () => {
      PK.assertOwnerStoragePath(f.OWNER, p);
      const v = f.storage.get(p);
      if (!v) throw new Error(`no existe ${p}`);
      return v;
    }),
  };
  return { L, stats };
}

// Carga EN SERIE de referencia: el mismo loadContentsV3 con un cargador que solo deja una descarga a la vez.
function serialized(L) {
  let chain = Promise.resolve();
  const one = (fn) => (...a) => { const p = chain.then(() => fn(...a)); chain = p.then(() => {}, () => {}); return p; };
  return { loadText: one(L.loadText), loadBytes: one(L.loadBytes), loadStorageBytes: one(L.loadStorageBytes) };
}

async function main() {
  // ── runOrderedWithLimit ──
  await check('runOrderedWithLimit: resultado en el orden de las tareas (no el de llegada) y nunca más de `limit` en vuelo', async () => {
    let inflight = 0;
    let max = 0;
    const tasks = Array.from({ length: 25 }, (_, i) => async () => {
      inflight++; max = Math.max(max, inflight);
      await sleep((i * 7) % 11);
      inflight--;
      return i;
    });
    eq(await OL.runOrderedWithLimit(tasks, 4), Array.from({ length: 25 }, (_, i) => i), 'orden');
    eq(max, 4, 'en vuelo');
    eq(await OL.runOrderedWithLimit([], 6), [], 'vacío');
    eq(await OL.runOrderedWithLimit([async () => 'a'], 0), ['a'], 'limit 0 → 1');
  });
  await check('runOrderedWithLimit: rechaza con el error de MENOR índice aunque uno posterior falle antes; no arranca nada tras la falla; absorbe rechazos tardíos', async () => {
    const started = [];
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const tasks = Array.from({ length: 20 }, (_, i) => async () => {
        started.push(i);
        if (i === 2) { await sleep(30); throw new Error('falla-2'); }
        if (i === 4) { await sleep(1); throw new Error('falla-4'); }
        if (i === 3) { await sleep(40); throw new Error('falla-3-tardía'); }
        await sleep(5);
        return i;
      });
      let err = null;
      try { await OL.runOrderedWithLimit(tasks, 6); } catch (e) { err = e; }
      assert(err && err.message === 'falla-2', `error: ${err && err.message}`);
      eq(started, [0, 1, 2, 3, 4, 5], 'solo las 6 primeras arrancaron (la falla de 4 frenó el resto)');
      await sleep(60);
      eq(unhandled, 0, 'sin unhandledRejection');
      // throw sincrónico dentro de la tarea
      let e2 = null;
      try { await OL.runOrderedWithLimit([() => { throw new Error('sync'); }], 3); } catch (e) { e2 = e; }
      assert(e2 && e2.message === 'sync', 'throw sincrónico');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  for (const engine of ['h5p', 'scorm']) {
    const f = realRunFixture(engine);
    const byItem = await PK.resolveRunArtifactsV3(f.q, f.run.id, f.manifest);
    const plan = PV3.buildPackagingPlanV3(f.manifest, f.fx.blueprint, { manifestId: 9001 });
    const theme = { familyId: 'aula-clara', mode: 'light' };
    let total = 0;
    for (const it of byItem.values()) total += it.artifacts.length;

    await check(`${engine}: carga concurrente con demoras al azar = carga en serie (contenido, orden de cada Map, avisos en orden, mocks) y concurrencia real ≤ 6`, async () => {
      const ser = fakeLoaders(f, { delay: () => 1 });
      const t0 = Date.now();
      const a = await PK.loadContentsV3(serialized(ser.L), plan, byItem, f.run, theme);
      const serialMs = Date.now() - t0;
      eq(ser.stats.maxInflight, 1, 'referencia en serie');
      // demoras pseudoaleatorias (deterministas por clave) para desordenar las llegadas
      const delay = (key) => (parseInt(sha(key).slice(0, 4), 16) % 23) + 1;
      const con = fakeLoaders(f, { delay });
      const b = await PK.loadContentsV3(con.L, plan, byItem, f.run, theme);
      eq(PK.PACKAGING_V3_DOWNLOAD_CONCURRENCY, 6, 'límite');
      assert(con.stats.maxInflight > 1 && con.stats.maxInflight <= 6, `en vuelo: ${con.stats.maxInflight}`);
      eq(canon(b.contents), canon(a.contents), 'contenidos');
      eq(b.warnings, a.warnings, 'avisos (en orden)');
      eq(b.mockProviderItems, a.mockProviderItems, 'mocks');
      eq(con.stats.started.length, ser.stats.started.length, 'mismas descargas');
      // y los contenidos son los de la fuente
      eq(canon(b.contents.contentMd), canon(f.fx.contents.contentMd), 'markdown = fuente');
      eq(canon(b.contents.audiobookChapters), canon(f.fx.contents.audiobookChapters), 'audio = fuente');
      eq(canon(b.contents.presentations), canon(new Map([...f.fx.contents.presentations].map(([k, v]) => [k, { pdf: v.pdf, cover: v.cover }]))), 'presentaciones = fuente');
      const expectedWarnings = [];
      plan.modules.flatMap((m) => m.chapters).forEach((ch, i) => {
        if (i % 2) expectedWarnings.push(`slide_count_declared_mismatch:${ch.keys.presentation}`);
        expectedWarnings.push(`theme:${ch.keys.presentation}`);
      });
      // theme_mismatch (con config de temas Gamma) o theme_mismatch_unknown (sin ella): da igual cuál, importa el orden.
      const norm = (w) => w.replace(/^theme_mismatch(?:_unknown)?:(presentation:[^:]+):.*$/, 'theme:$1');
      eq(b.warnings.map(norm), expectedWarnings, 'avisos esperados por capítulo, en el orden del plan');
      console.log(`   (${engine}: ${ser.stats.started.length} descargas; en serie ${serialMs} ms con 1 ms c/u; concurrente con máx. ${con.stats.maxInflight} en vuelo)`);
    });

    await check(`${engine}: el .mbz armado con la carga concurrente es byte a byte el de la carga en serie (sha256)`, async () => {
      const a = await PK.loadContentsV3(serialized(fakeLoaders(f).L), plan, byItem, f.run, theme);
      const delay = (key) => (parseInt(sha('x' + key).slice(0, 4), 16) % 13) + 1;
      const b = await PK.loadContentsV3(fakeLoaders(f, { delay }).L, plan, byItem, f.run, theme);
      const mk = (contents) => B.buildDynamicMbzV3({ ...f.fx, contents });
      const ra = await mk(a.contents);
      const rb = await mk(b.contents);
      eq(sha(rb.mbz), sha(ra.mbz), 'sha del .mbz');
    });

    await check(`${engine}: fail fast — una descarga que falla rechaza con SU error y no arranca descargas nuevas después`, async () => {
      const ids = [...byItem.values()].flatMap((it) => it.artifacts.map((x) => x.artifactId));
      const victim = ids[Math.floor(ids.length / 3)];
      let failedAt = null;
      const { L, stats } = fakeLoaders(f, {
        delay: (k) => (k === victim ? 15 : 5),
        fail: (k) => { if (k === victim) { failedAt = Date.now(); return new Error(`HTTP 500 descargando ${k}`); } return null; },
      });
      let err = null;
      try { await PK.loadContentsV3(L, plan, byItem, f.run, theme); } catch (e) { err = e; }
      assert(err && err.message === `HTTP 500 descargando ${victim}`, `error: ${err && err.message}`);
      const after = stats.started.filter((s) => s.t > failedAt);
      eq(after.length, 0, 'descargas arrancadas después de la falla');
      assert(stats.started.length < total, `no se descargó todo (${stats.started.length}/${total})`);
    });

    await check(`${engine}: con dos fallas gana la del orden secuencial aunque la posterior falle primero`, async () => {
      const ids = [...byItem.values()].flatMap((it) => it.artifacts.map((x) => x.artifactId)).sort();
      const early = ids[3];
      const late = ids[5];
      const { L } = fakeLoaders(f, {
        delay: (k) => (k === early ? 40 : k === late ? 1 : 3),
        fail: (k) => (k === early ? new Error('temprana') : k === late ? new Error('tardía') : null),
      });
      let err = null;
      try { await PK.loadContentsV3(L, plan, byItem, f.run, theme); } catch (e) { err = e; }
      // el orden secuencial de loadContentsV3 es el del plan; ids ordenados = orden de alta, que sigue al Manifest
      const serialErr = await PK.loadContentsV3(serialized(fakeLoaders(f, {
        fail: (k) => (k === early ? new Error('temprana') : k === late ? new Error('tardía') : null),
      }).L), plan, byItem, f.run, theme).then(() => null, (e) => e);
      assert(serialErr, 'la referencia en serie falla');
      eq(err && err.message, serialErr.message, 'mismo error que en serie');
    });
  }

  await check('PackagingNotReadyError (video sin YouTube) no se cambia por el error de red de un capítulo posterior', async () => {
    const f = realRunFixture('h5p');
    const byItem = await PK.resolveRunArtifactsV3(f.q, f.run.id, f.manifest);
    const plan = PV3.buildPackagingPlanV3(f.manifest, f.fx.blueprint, { manifestId: 9001 });
    const chs = plan.modules.flatMap((m) => m.chapters);
    const firstVideo = chs.findIndex((c) => c.keys.video);
    assert(firstVideo >= 0 && firstVideo < chs.length - 1, 'fixture con video y capítulos posteriores');
    const lateAudio = byItem.get(chs[chs.length - 1].keys.audiobookChapter).artifacts[0].artifactId;
    const run = { ...f.run, input_payload: { videoMode: 'real', videoDelivery: 'videogen_direct' } };
    const { L } = fakeLoaders(f, { delay: (k) => (k === lateAudio ? 0 : 10), fail: (k) => (k === lateAudio ? new Error('red') : null) });
    let err = null;
    try { await PK.loadContentsV3(L, plan, byItem, run, { familyId: 'aula-clara', mode: 'light' }); } catch (e) { err = e; }
    assert(err instanceof PT.PackagingNotReadyError, `esperado PackagingNotReadyError, vino ${err && err.constructor.name}: ${err && err.message}`);
    assert(/V3_VIDEO_REQUIRES_YOUTUBE|YouTube/.test(err.message), err.message);
  });
}

main().catch((err) => { failures++; console.error('❌ inesperado:', err && err.stack ? err.stack : err); }).then(() => {
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures > 0 ? 1 : 0);
});
