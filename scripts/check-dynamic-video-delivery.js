#!/usr/bin/env node
/* eslint-disable */
// Fase 5B.2.A — entrega final del video del flujo dynamic (sin DB, sin red).
//
// Verifica, con los módulos COMPILADOS de dist/:
//  1. Tabla de verdad COMPLETA de dynamicVideoDeliveryPhase (2 estrategias ×
//     7 estados de entrega × 10 estados de Videogen), contra una tabla
//     esperada escrita acá a mano (no derivada del código).
//  2. Config DYNAMIC_VIDEO_DELIVERY fail-fast y lectura del valor congelado
//     por run (ausente → videogen_direct, desconocido → error).
//  3. Validación de la URL de YouTube (https, host, sin firma, id).
//  4. parseDynamicVideo: videogen_direct idéntico a 5B.1; youtube usa
//     youtubeUrl y, si falta/es inválida/firmada → PackagingNotReadyError
//     (409), NUNCA la URL de Videogen.
//  5. buildDynamicMbz: con videogen_direct el .mbz es BYTE-IDÉNTICO al de
//     5B.1 (sha256 fijado, reloj congelado); con youtube la URL de YouTube
//     cae en la actividad url del capítulo correcto (por UUID) y el texto
//     cambia a "se abre en YouTube".
//
// Usage:
//   node scripts/check-dynamic-video-delivery.js [path/to/dist] [path/to/baseline-dist]
// (baseline-dist opcional: si se pasa, además compara byte a byte contra el
// builder de esa build.)

const path = require('path');
const crypto = require('crypto');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const baselineRoot = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : null;

function loadFrom(root, relPath) {
  const abs = path.join(root, relPath);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}
const loadDist = (rel) => loadFrom(distRoot, rel);

const D = loadDist('modules/dynamic-generation/dynamic-video-delivery.js');
const { isJobCompleted } = loadDist('video-engine/videogen.service.js');
const { parseDynamicVideo } = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const { PackagingNotReadyError } = loadDist('modules/dynamic-packaging/packaging-types.js');
const { buildBlueprintSnapshot, snapshotSha256 } = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const { buildGenerationManifest } = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const { buildPackagingPlan } = loadDist('modules/dynamic-packaging/packaging-plan.js');
const { buildDynamicMbz } = loadDist('package/dynamic-mbz-builder.js');
const JSZip = require('jszip');

/**
 * sha256 del .mbz de la fixture (videogen_direct) producido por el builder de
 * 5B.1 (commit ca72f2a, DYNAMIC_MBZ_BUILDER_VERSION 1.1.0) con el reloj
 * congelado en FROZEN_MS y Math.random determinístico (verificado byte a byte
 * contra una build de ca72f2a pasando su dist como segundo argumento). Si esto cambia, el .mbz de videogen_direct dejó de
 * ser byte-idéntico: subir DYNAMIC_MBZ_BUILDER_VERSION y justificarlo.
 */
const PINNED_VIDEOGEN_DIRECT_SHA256 = '9fb07215ab024588139547f986b89438c6e236c1348368f426af21f2d9504c61';
const FROZEN_MS = Date.UTC(2026, 8, 25, 12, 0, 0);

let failures = 0;
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
async function checkAsync(name, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: esperado ${e}, encontrado ${a}`);
}
function assertThrows(fn, pred, msg) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error(`${msg}: no lanzó`);
  if (pred && !pred(threw)) throw new Error(`${msg}: lanzó otra cosa (${threw && threw.name}: ${threw && threw.message})`);
  return threw;
}

// ─── 1. Tabla de verdad ─────────────────────────────────────────────────────

const VIDEOGEN_STATUSES = [null, 'queued', 'processing', 'completed', 'completed_local', 'done', 'success', 'finished', 'failed', 'COMPLETED_LOCAL'];
const READY = new Set(['completed', 'completed_local', 'done', 'success', 'finished', 'COMPLETED_LOCAL']);
const DELIVERY_STATES = [null, 'pending', 'completed_local', 'uploading_youtube', 'completed', 'blocked_auth', 'blocked_quota', 'upload_failed', 'ambiguous'];

// Tabla esperada escrita a mano desde el spec §2 (no derivada del código).
function expected(strategy, vg, st) {
  const ready = READY.has(vg);
  const s = st === null ? 'pending' : st;
  if (strategy === 'videogen_direct') {
    if (s === 'uploading_youtube' || s === 'blocked_auth' || s === 'blocked_quota' || s === 'upload_failed' || s === 'ambiguous') return 'THROW';
    if (s === 'completed_local' || s === 'completed') return { itemTerminal: true, next: 'done' };
    return ready ? { itemTerminal: true, next: 'done' } : { itemTerminal: false, next: 'poll_videogen' };
  }
  if (s === 'completed') return { itemTerminal: true, next: 'done' };
  if (s === 'completed_local' || s === 'uploading_youtube') return { itemTerminal: false, next: 'publish_youtube' };
  // DN-1: upload_failed → se reintenta SOLO la subida; ambiguous → nunca re-sube solo (resolución explícita).
  if (s === 'upload_failed') return { itemTerminal: false, next: 'publish_youtube' };
  if (s === 'ambiguous') return { itemTerminal: false, next: 'resolve_ambiguous' };
  if (s === 'blocked_auth') return { itemTerminal: false, next: 'wait_auth' };
  if (s === 'blocked_quota') return { itemTerminal: false, next: 'wait_quota' };
  return ready ? { itemTerminal: false, next: 'publish_youtube' } : { itemTerminal: false, next: 'poll_videogen' };
}

check('Tabla de verdad completa de dynamicVideoDeliveryPhase (2 × 9 × 10 = 180 combinaciones)', () => {
  let n = 0;
  for (const strategy of ['videogen_direct', 'youtube']) {
    for (const st of DELIVERY_STATES) {
      for (const vg of VIDEOGEN_STATUSES) {
        n += 1;
        const exp = expected(strategy, vg, st);
        const label = `${strategy}/${st}/${vg}`;
        if (exp === 'THROW') {
          assertThrows(() => D.dynamicVideoDeliveryPhase(vg, st, strategy), null, label);
        } else {
          assertDeepEqual(D.dynamicVideoDeliveryPhase(vg, st, strategy), exp, label);
        }
      }
    }
  }
  assert(n === 180, `combinaciones ${n}`);
});

check('Spec: completed_local terminal SIN YouTube; completed_local y uploading_youtube intermedios CON YouTube; completed terminal', () => {
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'pending', 'videogen_direct'), { itemTerminal: true, next: 'done' }, 'vd render completed_local');
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'completed_local', 'videogen_direct'), { itemTerminal: true, next: 'done' }, 'vd state completed_local');
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'pending', 'youtube'), { itemTerminal: false, next: 'publish_youtube' }, 'yt render completed_local');
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'completed_local', 'youtube'), { itemTerminal: false, next: 'publish_youtube' }, 'yt state completed_local');
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'uploading_youtube', 'youtube'), { itemTerminal: false, next: 'publish_youtube' }, 'yt uploading');
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'completed', 'youtube'), { itemTerminal: true, next: 'done' }, 'yt completed');
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'blocked_auth', 'youtube'), { itemTerminal: false, next: 'wait_auth' }, 'yt blocked_auth');
  assertDeepEqual(D.dynamicVideoDeliveryPhase('completed_local', 'blocked_quota', 'youtube'), { itemTerminal: false, next: 'wait_quota' }, 'yt blocked_quota');
});

check('Estados/estrategias desconocidos lanzan (nunca un default silencioso)', () => {
  assertThrows(() => D.dynamicVideoDeliveryPhase('completed', 'uploaded', 'youtube'), null, 'estado desconocido');
  assertThrows(() => D.dynamicVideoDeliveryPhase('completed', 'pending', 'own_storage'), null, 'estrategia desconocida');
  assertThrows(() => D.dynamicVideoDeliveryPhase('completed', 'pending', undefined), null, 'estrategia undefined');
});

check('isVideogenRenderReady ≡ isDynamicVideoCompleted (isJobCompleted || completed_local) — semántica 5A intacta', () => {
  for (const s of [...VIDEOGEN_STATUSES, 'Completed', 'DONE', 'error', 'cancelled', '']) {
    const legacy = isJobCompleted(s ?? '') || String(s ?? '').toLowerCase() === 'completed_local';
    assert(D.isVideogenRenderReady(s) === legacy, `status ${s}: ${D.isVideogenRenderReady(s)} vs ${legacy}`);
  }
});

// ─── 2. Config y valor congelado ────────────────────────────────────────────

check('DYNAMIC_VIDEO_DELIVERY: ausente/vacío → videogen_direct; válidos; desconocido → error (fail-fast)', () => {
  assert(D.parseVideoDeliveryConfig(undefined) === 'videogen_direct', 'undefined');
  assert(D.parseVideoDeliveryConfig('') === 'videogen_direct', 'vacío');
  assert(D.parseVideoDeliveryConfig('   ') === 'videogen_direct', 'espacios');
  assert(D.parseVideoDeliveryConfig('videogen_direct') === 'videogen_direct', 'videogen_direct');
  assert(D.parseVideoDeliveryConfig(' youtube ') === 'youtube', 'youtube');
  for (const bad of ['YouTube', 'yt', 'own_storage', 'videogen', 'true']) {
    assertThrows(() => D.parseVideoDeliveryConfig(bad), (e) => /DYNAMIC_VIDEO_DELIVERY/.test(e.message), `valor ${bad}`);
    assertThrows(() => D.readVideoDeliveryConfig({ DYNAMIC_VIDEO_DELIVERY: bad }), null, `env ${bad}`);
  }
  assert(D.readVideoDeliveryConfig({}) === 'videogen_direct', 'env vacío');
});

check('Valor congelado por run: sin campo → videogen_direct; youtube; desconocido → error', () => {
  assert(D.frozenVideoDeliveryOf({ manifestId: 1, videoMode: 'real' }) === 'videogen_direct', 'run 5A/5B.1 sin campo');
  assert(D.frozenVideoDeliveryOf(null) === 'videogen_direct', 'null');
  assert(D.frozenVideoDeliveryOf({ videoDelivery: 'youtube' }) === 'youtube', 'youtube');
  assertThrows(() => D.frozenVideoDeliveryOf({ videoDelivery: 'vimeo' }), null, 'desconocido');
});

// ─── 3. URL de YouTube ──────────────────────────────────────────────────────

const YT_ID = 'dQw4w9WgXcQ';
check('checkYoutubeDeliveryUrl: acepta watch?v= y youtu.be; rechaza firma, host ajeno, http, extras', () => {
  for (const ok of [
    `https://www.youtube.com/watch?v=${YT_ID}`,
    `https://youtube.com/watch?v=${YT_ID}`,
    `https://youtu.be/${YT_ID}`,
  ]) {
    const r = D.checkYoutubeDeliveryUrl(ok);
    assert(r.ok === true && r.videoId === YT_ID, `debería aceptar ${ok}: ${JSON.stringify(r)}`);
  }
  for (const bad of [
    undefined,
    '',
    `http://www.youtube.com/watch?v=${YT_ID}`,
    `https://www.youtube.com/watch?v=${YT_ID}&token=abc`,
    `https://www.youtube.com/watch?v=${YT_ID}&sig=abc&expire=1`,
    `https://www.youtube.com/watch?v=${YT_ID}&t=10`,
    `https://youtu.be/${YT_ID}?token=abc`,
    `https://youtu.be/${YT_ID}?si=share`,
    `https://www.youtube.com/embed/${YT_ID}`,
    `https://www.youtube.com.evil.com/watch?v=${YT_ID}`,
    `https://evil.com/watch?v=${YT_ID}`,
    `https://videosb.nomaddi.com/api/videos/x/download`,
    `https://abc.supabase.co/storage/v1/object/sign/cursia-artifacts/x.mp4?token=abc`,
    `https://user:pw@www.youtube.com/watch?v=${YT_ID}`,
    `https://www.youtube.com:8443/watch?v=${YT_ID}`,
    `https://www.youtube.com/watch?v=${YT_ID}#t=1`,
    `https://www.youtube.com/watch?v=short`,
    `https://youtu.be/${YT_ID}extra`,
  ]) {
    const r = D.checkYoutubeDeliveryUrl(bad);
    assert(r.ok === false && typeof r.reason === 'string', `debería rechazar ${bad}: ${JSON.stringify(r)}`);
  }
});

// ─── 4. parseDynamicVideo ───────────────────────────────────────────────────

const VG_URL = 'https://videosb.nomaddi.com/api/videos/abc/download';
const baseArtifact = { videogenJobId: 'job-1', downloadUrl: VG_URL, status: 'completed_local', mode: 'real', chapterId: 'c1', itemKey: 'video:c1' };

check('parseDynamicVideo videogen_direct: salida idéntica a 5B.1 ({url, videogenJobId}, sin campos nuevos), con y sin estrategia explícita', () => {
  assertDeepEqual(parseDynamicVideo(baseArtifact), { url: VG_URL, videogenJobId: 'job-1' }, 'default');
  assertDeepEqual(parseDynamicVideo(baseArtifact, 'videogen_direct'), { url: VG_URL, videogenJobId: 'job-1' }, 'explícito');
  assertDeepEqual(parseDynamicVideo(JSON.stringify(baseArtifact), 'videogen_direct'), { url: VG_URL, videogenJobId: 'job-1' }, 'string');
  // Un artifact youtube publicado sigue teniendo downloadUrl de Videogen; con
  // videogen_direct, declarar delivery=youtube es un desajuste → error.
  assertThrows(() => parseDynamicVideo({ ...baseArtifact, delivery: 'youtube' }, 'videogen_direct'), (e) => e instanceof PackagingNotReadyError, 'delivery mismatch');
});

check('parseDynamicVideo videogen_direct: reglas 5B.1 intactas (signed, http, mock, mode)', () => {
  assertThrows(() => parseDynamicVideo({ ...baseArtifact, downloadUrl: `${VG_URL}?token=x` }), (e) => /signed URL/.test(e.message), 'signed');
  assertThrows(() => parseDynamicVideo({ ...baseArtifact, downloadUrl: 'http://videosb.nomaddi.com/x' }), (e) => /https/.test(e.message), 'http');
  assertThrows(() => parseDynamicVideo({ ...baseArtifact, downloadUrl: 'https://mock-cdn.cursia.local/x.mp4' }), (e) => /simulados/.test(e.message), 'mock host');
  assertThrows(() => parseDynamicVideo({ ...baseArtifact, mode: 'mock' }), (e) => /simulados/.test(e.message), 'mode mock');
});

const ytArtifact = { ...baseArtifact, delivery: 'youtube', youtubeVideoId: YT_ID, youtubeUrl: `https://www.youtube.com/watch?v=${YT_ID}` };

check('parseDynamicVideo youtube: usa youtubeUrl (nunca downloadUrl de Videogen)', () => {
  assertDeepEqual(parseDynamicVideo(ytArtifact, 'youtube'), { url: `https://www.youtube.com/watch?v=${YT_ID}`, videogenJobId: 'job-1', delivery: 'youtube' }, 'watch');
  assertDeepEqual(
    parseDynamicVideo({ ...ytArtifact, youtubeUrl: `https://youtu.be/${YT_ID}` }, 'youtube'),
    { url: `https://youtu.be/${YT_ID}`, videogenJobId: 'job-1', delivery: 'youtube' },
    'youtu.be',
  );
});

check('parseDynamicVideo youtube: sin youtubeUrl → PackagingNotReadyError (409), nunca cae a Videogen', () => {
  const { youtubeUrl, ...noUrl } = ytArtifact;
  const e = assertThrows(() => parseDynamicVideo(noUrl, 'youtube'), (x) => x instanceof PackagingNotReadyError, 'sin youtubeUrl');
  assert(e.missing.some((m) => m.endsWith(':missing_youtube_url')), `missing=${JSON.stringify(e.missing)}`);
  // Un artifact de Videogen directo (sin delivery) en un run youtube tampoco cae a Videogen.
  assertThrows(() => parseDynamicVideo(baseArtifact, 'youtube'), (x) => x instanceof PackagingNotReadyError, 'artifact videogen_direct en run youtube');
});

check('parseDynamicVideo youtube: URL firmada / host inválido / id distinto → PackagingNotReadyError (409)', () => {
  for (const bad of [
    `https://www.youtube.com/watch?v=${YT_ID}&token=abc`,
    `https://youtu.be/${YT_ID}?sig=abc`,
    `https://www.youtube.com.evil.com/watch?v=${YT_ID}`,
    VG_URL,
    `https://abc.supabase.co/storage/v1/object/sign/cursia-artifacts/x.mp4?token=abc`,
    `http://www.youtube.com/watch?v=${YT_ID}`,
  ]) {
    const e = assertThrows(() => parseDynamicVideo({ ...ytArtifact, youtubeUrl: bad }, 'youtube'), (x) => x instanceof PackagingNotReadyError, bad);
    assert(e.missing.some((m) => m.endsWith(':invalid_youtube_url')), `${bad}: missing=${JSON.stringify(e.missing)}`);
  }
  assertThrows(() => parseDynamicVideo({ ...ytArtifact, youtubeVideoId: 'aaaaaaaaaaa' }, 'youtube'), (x) => x instanceof PackagingNotReadyError, 'id mismatch');
  assertThrows(() => parseDynamicVideo({ ...ytArtifact, mode: 'mock' }, 'youtube'), (x) => /simulados/.test(x.message), 'youtube mock mode');
});

// ─── 5. Builder ─────────────────────────────────────────────────────────────

const M = ['a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000004'];
const EXAM_BY_MODULE = [true, false, true, true];
const CHAPTERS_PER_MODULE = [2, 5, 1, 3];
const VIDEO_CHAPTER_NUMBERS = [1, 3, 5, 8, 10, 11];
const chapterUuid = (n) => `c2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function buildPlan() {
  const modules = M.map((id, i) => ({ id, position: i, title: `Módulo criterio ${i + 1}`, objective: `Objetivo del módulo ${i + 1}`, exam_enabled: EXAM_BY_MODULE[i] }));
  const chapters = [];
  let n = 0;
  CHAPTERS_PER_MODULE.forEach((count, mi) => {
    for (let ci = 0; ci < count; ci++) {
      n += 1;
      chapters.push({ id: chapterUuid(n), module_id: M[mi], position: ci, title: `Capítulo criterio ${n}`, objective: null, video_enabled: VIDEO_CHAPTER_NUMBERS.includes(n) });
    }
  });
  const snapshot = buildBlueprintSnapshot({ id: 9001, title: 'Curso fixture 5B.2.A' }, modules, chapters);
  const manifest = buildGenerationManifest(snapshot, { courseId: 9001, blueprintId: 9001, blueprintNumber: 1, blueprintSha256: snapshotSha256(snapshot) });
  return buildPackagingPlan(manifest, snapshot, { manifestId: 9001 });
}

/** Id de YouTube (11 chars) determinístico por UUID de capítulo. */
const ytIdFor = (uuid) => crypto.createHash('sha256').update(uuid).digest('base64url').slice(0, 11);

function buildContents(plan, strategy) {
  const contents = { contentMd: new Map(), scorm: new Map(), examGift: new Map(), videos: new Map() };
  for (const m of plan.modules) {
    if (m.examItemKey) contents.examGift.set(m.moduleId, `::Q1:: Pregunta ${m.moduleId} {=a ~b}\n\n::Q2:: Otra {=c ~d}`);
    for (const c of m.chapters) {
      contents.contentMd.set(c.chapterId, `# ${c.title}\n\nContenido ${c.chapterId}.`);
      contents.scorm.set(c.chapterId, { html: `<html><body><h1>${c.chapterId}</h1></body></html>`, manifestXml: `<?xml version="1.0"?><manifest identifier="cap${c.chapterNumber}"></manifest>` });
      if (c.videoItemKey) {
        const vgArtifact = { videogenJobId: `job-${c.chapterId}`, downloadUrl: `https://videosb.nomaddi.com/api/videos/${c.chapterId}/download`, mode: 'real', chapterId: c.chapterId, itemKey: c.videoItemKey };
        const artifact = strategy === 'youtube'
          ? { ...vgArtifact, delivery: 'youtube', youtubeVideoId: ytIdFor(c.chapterId), youtubeUrl: `https://www.youtube.com/watch?v=${ytIdFor(c.chapterId)}` }
          : vgArtifact;
        // Mismo camino que el worker: parseDynamicVideo(artifact, estrategia congelada).
        contents.videos.set(c.chapterId, parseDynamicVideo(artifact, strategy));
      }
    }
  }
  return contents;
}

/**
 * Ejecuta fn con Date congelado (Date.now y new Date() sin args — JSZip fecha
 * cada entrada) y Math.random determinístico (los `<stamp>` de las
 * categorías de preguntas usan Math.random) — reiniciado en cada llamada.
 */
async function withFrozenClock(fn) {
  const RealDate = Date;
  const realRandom = Math.random;
  let seed = 0x5b2a;
  Math.random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x100000000;
  };
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FROZEN_MS);
      else super(...args);
    }
    static now() {
      return FROZEN_MS;
    }
  }
  global.Date = FrozenDate;
  try {
    return await fn();
  } finally {
    global.Date = RealDate;
    Math.random = realRandom;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function readActivities(buf) {
  const zip = await JSZip.loadAsync(buf);
  const text = (f) => zip.file(f).async('string');
  const sectionOf = {};
  for (const f of Object.keys(zip.files).filter((x) => /^sections\/section_\d+\/section\.xml$/.test(x))) {
    const x = await text(f);
    const num = Number((x.match(/<number>(\d+)<\/number>/) || [])[1]);
    const seq = (x.match(/<sequence>([^<]*)<\/sequence>/) || [])[1] || '';
    seq.split(',').filter(Boolean).forEach((mid, idx) => { sectionOf[mid] = { section: num, index: idx }; });
  }
  const acts = [];
  for (const f of Object.keys(zip.files).filter((x) => /^activities\/(\w+)_(\d+)\/\1\.xml$/.test(x))) {
    const [, modname, mid] = f.match(/^activities\/(\w+)_(\d+)\//);
    acts.push({ modname, mid, xml: await text(f), ...sectionOf[mid] });
  }
  return acts;
}

(async () => {
  const plan = buildPlan();

  let vdBuf;
  await checkAsync('.mbz videogen_direct: sha256 byte-idéntico al de 5B.1 (fijado)', async () => {
    vdBuf = await withFrozenClock(() => buildDynamicMbz({ plan, contents: buildContents(plan, 'videogen_direct') }));
    const again = await withFrozenClock(() => buildDynamicMbz({ plan, contents: buildContents(plan, 'videogen_direct') }));
    assert(sha256(vdBuf) === sha256(again), 'el builder no es determinístico con el reloj congelado');
    assert(sha256(vdBuf) === PINNED_VIDEOGEN_DIRECT_SHA256, `sha256 ${sha256(vdBuf)} ≠ fijado ${PINNED_VIDEOGEN_DIRECT_SHA256}`);
  });

  if (baselineRoot) {
    await checkAsync(`.mbz videogen_direct: byte-idéntico al builder de ${baselineRoot}`, async () => {
      const base = loadFrom(baselineRoot, 'package/dynamic-mbz-builder.js');
      const baseContents = buildContents(plan, 'videogen_direct');
      const baseBuf = await withFrozenClock(() => base.buildDynamicMbz({ plan, contents: baseContents }));
      assert(sha256(baseBuf) === sha256(vdBuf), `baseline ${sha256(baseBuf)} ≠ actual ${sha256(vdBuf)}`);
    });
  }

  await checkAsync('.mbz videogen_direct: texto "pestaña externa" y URL de Videogen (sin YouTube)', async () => {
    const acts = await readActivities(vdBuf);
    const urls = acts.filter((a) => a.modname === 'url');
    assert(urls.length === 6, `esperado 6 url, encontrado ${urls.length}`);
    for (const u of urls) {
      assert(/<externalurl>https:\/\/videosb\.nomaddi\.com\/api\/videos\/[0-9a-f-]{36}\/download<\/externalurl>/.test(u.xml), `url ${u.mid} no es Videogen`);
      assert(u.xml.includes('se abre en una pestaña externa'), `url ${u.mid} sin el texto 5B.1`);
      assert(!/youtube|youtu\.be/i.test(u.xml), `url ${u.mid} menciona YouTube`);
    }
  });

  await checkAsync('.mbz youtube (DN-1): cada video es un LABEL (no url) en el lugar del capítulo, con el link embebible de SU id (UUID) + respaldo nomediaplugin', async () => {
    const buf = await withFrozenClock(() => buildDynamicMbz({ plan, contents: buildContents(plan, 'youtube') }));
    const acts = await readActivities(buf);
    const chapters = plan.modules.flatMap((m) => m.chapters.map((c) => ({ ...c, sectionNum: m.sectionNum })));
    const chapterByYtId = Object.fromEntries(chapters.filter((c) => c.videoItemKey).map((c) => [ytIdFor(c.chapterId), c]));
    assert(acts.filter((a) => a.modname === 'url').length === 0, 'un run youtube no debe tener actividades url');
    const videoLabels = acts.filter((a) => a.modname === 'label' && /<name>🎬 Video del capítulo/.test(a.xml));
    assert(videoLabels.length === 6, `esperado 6 labels de video, encontrado ${videoLabels.length}`);
    const got = [];
    for (const l of videoLabels) {
      const hrefs = [...l.xml.matchAll(/&lt;a (class=&quot;nomediaplugin&quot; )?href=&quot;([^&]*)&quot;/g)];
      assert(hrefs.length === 2, `label ${l.mid}: esperado 2 links, ${hrefs.length}`);
      assert(!hrefs[0][1] && hrefs[1][1], `label ${l.mid}: el 1º link debe ser plano (embebible) y el 2º nomediaplugin`);
      const m0 = hrefs[0][2].match(/^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/);
      assert(m0 && hrefs[1][2] === hrefs[0][2], `label ${l.mid}: links no son el watch de YouTube: ${hrefs.map((h) => h[2])}`);
      const ch = chapterByYtId[m0[1]];
      assert(ch, `label ${l.mid}: id ${m0[1]} no corresponde a ningún capítulo`);
      const name = (l.xml.match(/<name>([^<]*)<\/name>/) || [])[1] || '';
      assert(name.includes(`Video del capítulo ${ch.chapterNumber} `), `label ${l.mid}: nombre "${name}" no es del capítulo ${ch.chapterNumber}`);
      assert(l.section === ch.sectionNum, `video del cap ${ch.chapterNumber} en sección ${l.section}, esperado ${ch.sectionNum}`);
      // Mismo lugar que la url de videogen_direct: justo después de la tarjeta del capítulo.
      const intro = acts.find((a) => a.section === l.section && a.index === l.index - 1);
      assert(intro && intro.modname === 'label' && intro.xml.includes(`Capítulo ${ch.chapterNumber}`), `label ${l.mid}: no está justo después de la intro del cap ${ch.chapterNumber}`);
      assert(!l.xml.includes('videosb') && !/\.mp4/i.test(l.xml), `label ${l.mid}: cayó a Videogen / MP4`);
      got.push([ch.chapterNumber, ch.chapterId]);
    }
    got.sort((a, b) => a[0] - b[0]);
    assertDeepEqual(got, VIDEO_CHAPTER_NUMBERS.map((n) => [n, chapterUuid(n)]), 'capítulos con video (por UUID)');
    const intros = acts.filter((a) => a.modname === 'label' && /Este capítulo incluye un video/.test(a.xml));
    assert(intros.length === 6 && intros.every((l) => l.xml.includes('justo debajo') && !l.xml.includes('pestaña externa')), 'aviso de intro no cambió a YouTube');
    // Mismos mids que videogen_direct (la url se reemplaza por el label en el mismo lugar).
    const vdActs = await readActivities(vdBuf);
    const vdUrlMids = vdActs.filter((a) => a.modname === 'url').map((a) => a.mid).sort();
    assertDeepEqual(videoLabels.map((l) => l.mid).sort(), vdUrlMids, 'mids de los videos youtube = mids de las url de videogen_direct');
    // Ningún archivo de video en el .mbz.
    const zip = await JSZip.loadAsync(buf);
    const filesXml = await zip.file('files.xml').async('string');
    assert(!/video\/mp4|\.mp4/i.test(filesXml), 'files.xml no debe tener MP4');
    const mb = await zip.file('moodle_backup.xml').async('string');
    assert(!/<modulename>url<\/modulename>/.test(mb), 'moodle_backup.xml no debe listar actividades url');
    assert(!buf.equals(vdBuf), 'el .mbz youtube no debería ser igual al de videogen_direct');
  });

  console.log(`\n${checks - failures}/${checks} checks OK`);
  if (failures > 0) {
    console.error(`❌ ${failures} check(s) fallaron — entrega de video 5B.2.A rota.`);
    process.exit(1);
  }
  console.log('✅ Entrega de video 5B.2.A OK (tabla de verdad, config, URL YouTube, resolver, builder byte-idéntico).');
})().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
