#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * r74 — cursos de CUALQUIER tamaño: entrega según la capacidad real. Sin IA, sin red, USD 0.
 *
 *   D1 plan de partes: módulos enteros, partes parejas, capítulo indivisible > parte, máximo de partes, límites del entorno
 *   D2 proyección: #87 (6 × 5, ≈ 278 / 345 MiB) ya NO bloquea → audiolibro aparte; bloqueo solo sin entrega posible;
 *      sin `delivery` (llamadores viejos) el veredicto de siempre
 *   D3 compatibilidad: un curso chico arma EXACTAMENTE los mismos bytes que el builder de origin/staging (--base=<dist>)
 *   D4 30 / 60 / 120 capítulos con medios de tamaño REAL (audio 48 kbps incompresible, portadas de ruido): paquete
 *      recomendado (UN .mbz, audiolibro en línea con direcciones duraderas) + versión autocontenida (un archivo si cabe en
 *      el almacenamiento, si no principal + partes de audio), cada archivo validado y ≤ su tope; nada se pierde frente al
 *      paquete de referencia de siempre (mismas actividades, mismo audio medido)
 *   D5 interrupción: corte del proceso a mitad de una subida (objeto a medias, sin fila) y en cada paso → el reintento
 *      reutiliza lo subido y termina con los mismos bytes y las mismas direcciones
 *   D6 integridad de descarga: sha256 de cada archivo guardado = el del resumen; el zip abre y cada entrada pasa su CRC
 *   D7 direcciones duraderas: 302 a una URL firmada NUEVA; clave/archivo/tipo incorrectos → 404; revocado → 410; sin
 *      firma temporal dentro del .mbz
 *   D8 (--moodle) restauración REAL en Moodle 4.5 local: recomendado como curso nuevo; autocontenido (curso nuevo + combinar
 *      partes); referencia de siempre; conteos de actividades/archivos/MP3 antes y después, sha1 de cada MP3 en disco,
 *      reproductores tras format_text. Portabilidad: copia NATIVA de Moodle del curso autocontenido → restauración en
 *      OTRA instancia limpia (Moodle 4.5 de moodle-versions/m405) → idéntica; y el recomendado en la otra instancia
 *      conserva sus direcciones.
 *
 * Uso: npm run build && node --max-old-space-size=8192 scripts/check-r74-large-delivery.js [--sizes=30,60,120]
 *        [--base=<dist de origin/staging>] [--moodle] [--out=<dir>]
 */
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const ROOT = path.resolve(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const L = (r) => require(path.join(dist, r));
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const SIZES = (arg('sizes') || '30,60,120').split(',').map(Number);
const BASE = arg('base');
const MOODLE = process.argv.includes('--moodle');
const OUT = arg('out') || path.join(os.homedir(), 'cursia-test-env/work/r74/out');
const R = require('./lib/r74-large-course');
const B = L('package/dynamic-mbz-builder-v3.js');
const VAL = L('package/v3/mbz-validator-v3.js');
const PV = L('package/v3/audiobook-part-validator.js');
const S = L('modules/dynamic-packaging/split-delivery-v3.js');
const DP = L('package/v3/delivery-plan.js');
const PJ = L('package/v3/package-size-projection.js');
const CM = L('modules/course-media/course-media.service.js');
const JSZip = require('jszip');

const MB = 1024 * 1024;
const BASE_URL = 'https://api-staging.cursia.nomaddi.com';
const STORAGE = 300000000;
let passes = 0;
let failures = 0;
const evidence = { generatedAt: new Date().toISOString(), courses: {} };
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); passes++; console.log(`✅ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack || e}`); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const validateMain = (mbz, b) => VAL.validateMbzV3(mbz, {
  facts: b.expectations.facts, resolved: b.expectations.resolved, examBankPlans: b.expectations.examBankPlans, shellProseByLabel: b.expectations.shellProseByLabel,
  builderVersion: b.expectations.builderVersion, moodleMinimum: b.expectations.moodleMinimum, internalVocabularyExempt: b.expectations.internalVocabularyExempt,
  internalVocabularyUserTexts: b.expectations.internalVocabularyUserTexts, ...(b.expectations.audiobookLinks ? { audiobookLinks: b.expectations.audiobookLinks } : {}),
});
const LIMITS = DP.deliveryLimitsFromEnv(STORAGE, {});
const ctxFor = (n, input, store, extra = {}) => ({
  jobId: '00000000-0000-4000-8000-0000000000aa', ownerId: 'owner-r74', courseId: `c${n}`, manifestId: 9001, runId: `run-${n}`, sourceIdsHash: `src${n}`,
  storagePrefix: `owner-r74/dynamic/c${n}/9001`, qa: false, limits: LIMITS, publicMediaBase: BASE_URL, buildInput: input, build: B.buildDynamicMbzV3,
  validateMain, validatePart: PV.validateAudiobookPartV3, store, mainMetadata: () => ({}), ...extra,
});
/** Actividades del .mbz (moodle_backup.xml) y archivos de files.xml. */
async function mbzShape(buf) {
  const z = await JSZip.loadAsync(buf);
  const mb = await z.file('moodle_backup.xml').async('string');
  const acts = Array.from(mb.matchAll(/<activity>\s*<moduleid>\d+<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>([a-z0-9]+)<\/modulename>/g), (m) => ({ sec: Number(m[1]), mod: m[2] }));
  const fx = await z.file('files.xml').async('string');
  const files = Array.from(fx.matchAll(/<filename>([^<]*)<\/filename>[\s\S]*?<filesize>(\d+)<\/filesize>/g), (m) => ({ name: m[1], size: Number(m[2]) })).filter((f) => f.name !== '.');
  const by = {};
  for (const a of acts) by[a.mod] = (by[a.mod] || 0) + 1;
  return { activities: acts.length, byModname: Object.fromEntries(Object.entries(by).sort()), files: files.length, fileBytes: files.reduce((s, f) => s + f.size, 0), mp3: files.filter((f) => /\.mp3$/i.test(f.name)) };
}
async function zipIntegrity(buf) {
  const z = await JSZip.loadAsync(buf, { checkCRC32: true });
  let n = 0;
  for (const f of Object.values(z.files)) { if (f.dir) continue; await f.async('nodebuffer'); n++; }
  return n;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  await check('D1 plan de partes: módulos enteros en orden, partes parejas, capítulo > parte y demasiadas partes fallan con motivo; límites del entorno', () => {
    const ch = (m, n, bytes) => Array.from({ length: n }, (_, i) => ({ chapterId: `${m}-${i}`, moduleId: m, bytes }));
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((m) => ch(m, 5, 7.5 * MB));
    const r = DP.planAudioParts(six, { partMaxBytes: 200 * MB, maxParts: 20 });
    assert(r.ok, JSON.stringify(r));
    eq(r.parts.map((p) => p.segments.map((s) => s.moduleId).join('')), ['ABC', 'DEF'], '6 módulos de 37,5 MiB → 2 partes parejas (3 + 3)');
    eq(r.parts.map((p) => p.partNumber), [2, 3], 'el principal es el archivo 1');
    eq(r.parts.flatMap((p) => p.segments.flatMap((s) => s.chapterIds)), six.map((c) => c.chapterId), 'orden del curso intacto');
    for (const p of r.parts) assert(p.bytes + DP.AUDIO_PART_OVERHEAD_BYTES <= 200 * MB, 'parte sobre el tope');
    const big = DP.planAudioParts(ch('A', 40, 7.5 * MB), { partMaxBytes: 100 * MB, maxParts: 20 });
    assert(big.ok && big.parts.length === 4 && big.parts.every((p) => p.segments.length === 1 && p.segments[0].moduleId === 'A'), `módulo de 300 MiB cortado en tramos: ${JSON.stringify(big.ok && big.parts.map((p) => p.segments[0].chapterIds.length))}`);
    eq(DP.planAudioParts(ch('A', 1, 300 * MB), { partMaxBytes: 200 * MB, maxParts: 20 }).reason, 'chapter_over_part', 'capítulo indivisible');
    eq(DP.planAudioParts(ch('A', 30, 7.5 * MB), { partMaxBytes: 16 * MB, maxParts: 5 }).reason, 'too_many_parts', 'máximo de partes');
    eq(DP.deliveryLimitsFromEnv(STORAGE, {}), { storageMaxBytes: STORAGE, partMaxBytes: 200 * MB, maxParts: 20 }, 'defaults');
    eq(DP.deliveryLimitsFromEnv(50 * MB, {}).partMaxBytes, 50 * MB, 'la parte nunca supera el almacenamiento');
    for (const bad of [{ PACKAGE_PART_MAX_BYTES: String(STORAGE + 1) }, { PACKAGE_PART_MAX_BYTES: 'x' }, { PACKAGE_PART_MAX_BYTES: '1000' }, { PACKAGE_MAX_AUDIO_PARTS: '0' }]) {
      let e = null;
      try { DP.deliveryLimitsFromEnv(STORAGE, bad); } catch (x) { e = x.message; }
      assert(e && e.startsWith('PACKAGE_SIZE_CONFIG_INVALID'), `${JSON.stringify(bad)} → ${e}`);
    }
  });

  await check('D2 proyección: #87 (30 cap., ≈ 277,9 / 344,5 MiB) ya no bloquea → audiolibro aparte en 2–3 archivos; solo bloquea sin entrega posible; sin delivery = veredicto de siempre', () => {
    const items = [{ type: 'audio_welcome' }];
    const moduleOf = {};
    for (let i = 0; i < 30; i++) {
      const chapterId = `c${i}`;
      moduleOf[chapterId] = `m${Math.floor(i / 5)}`;
      for (const type of ['content', 'experience', 'presentation', 'activity', 'audiobook_chapter']) items.push({ type, chapterId });
    }
    const modes = { presentation: 'real', audio: 'real' };
    const old = PJ.projectPackageSize(items, modes, { maxBytes: STORAGE });
    eq([old.verdict, (old.expectedBytes / MB).toFixed(1), (old.highBytes / MB).toFixed(1)], ['over', '277.9', '344.5'], 'el bloqueo de hoy (#87, mismas cifras que producción)');
    const p = PJ.projectPackageSize(items, modes, { maxBytes: STORAGE }, { delivery: LIMITS, moduleOfChapter: moduleOf });
    eq([p.verdict, p.error, p.delivery.mode, p.delivery.verdict], ['ok', null, 'audio_apart', 'ok'], '#87 con plan de entrega');
    assert(p.delivery.mainHighBytes < 100 * MB && p.delivery.partHighBytes.every((b) => b <= LIMITS.partMaxBytes), JSON.stringify(p.delivery));
    evidence.projection87 = { expectedMiB: +(p.expectedBytes / MB).toFixed(1), highMiB: +(p.highBytes / MB).toFixed(1), delivery: p.delivery };
    const small = PJ.projectPackageSize(items.slice(0, 26), modes, { maxBytes: STORAGE }, { delivery: LIMITS, moduleOfChapter: moduleOf });
    eq(small.delivery.mode, 'single', 'un curso chico sigue en un archivo');
    const tiny = PJ.projectPackageSize(items, modes, { maxBytes: 20 * MB }, { delivery: DP.deliveryLimitsFromEnv(20 * MB, {}), moduleOfChapter: moduleOf });
    assert(tiny.verdict === 'over' && /main_over_storage/.test(tiny.error), 'sin entrega posible → bloquea');
  });

  if (BASE) {
    await check('D3 compatibilidad: un curso chico (y el #1353 de 12 + 3) arma los MISMOS bytes que origin/staging; la entrega aparte no se activa', async () => {
      const V = require('./lib/v21-packaging-fixtures');
      const BB = require(path.join(BASE, 'package/dynamic-mbz-builder-v3.js'));
      for (const shape of ['course2', 'm12']) {
        const opts = shape === 'm12' ? { modules: [0, 1, 2].map(() => ({ examEnabled: true, chapters: [{ video: true, activity: true }, { activity: true }, { activity: true }, { activity: true }, { practice: true, activity: true }] })) } : {};
        const a = await B.buildDynamicMbzV3(V.packagingInput(dist, opts));
        const b = await BB.buildDynamicMbzV3(V.packagingInput(BASE, opts));
        eq(sha256(a.mbz), sha256(b.mbz), `${shape}: sha256 idéntico al builder de staging`);
        assert(!a.audiobookParts && !a.audiobookSegments && !a.summary.audiobookDelivery, `${shape}: sin entrega aparte`);
        assert(S.estimateSingleBytes(V.packagingInput(dist, opts)) <= LIMITS.partMaxBytes, `${shape}: el worker lo arma en un archivo`);
      }
    });
  }

  for (const n of SIZES) {
    const dir = path.join(OUT, `c${n}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let input;
    let store;
    let result;
    const ev = (evidence.courses[n] = {});
    await check(`D4 ${n} capítulos: recomendado UN .mbz (audiolibro en línea) + autocontenido validado, cada archivo ≤ su tope, nada perdido frente a la referencia`, async () => {
      input = R.largeCourseInput(dist, n);
      store = R.memoryStore();
      const est = S.estimateSingleBytes(input);
      assert(est > LIMITS.partMaxBytes, `${n}: debía no caber en un archivo (${est})`);
      result = await S.deliverSplitV3(ctxFor(n, input, store));
      eq(result.mode, 'linked', 'modo');
      const linked = result.primary.built.mbz;
      assert(linked.length <= STORAGE, 'recomendado ≤ almacenamiento');
      const shape = await mbzShape(linked);
      eq(shape.mp3.map((f) => f.name), ['audio_bienvenida.mp3'], 'el recomendado no trae el audiolibro adentro (solo la bienvenida)');
      eq(Object.keys(result.primary.built.expectations.audiobookLinks).length, result.media.length, 'una dirección por segmento');
      for (const m of result.media) {
        assert(m.url.startsWith(`${BASE_URL}/api/v1/media/`) && !/[?&]token=|Signature|Expires/.test(m.url), m.url);
        assert(m.bytes <= LIMITS.partMaxBytes, 'MP3 en línea ≤ parte');
      }
      for (const f of result.selfContained.files) assert(f.bytes <= (f.role === 'main' ? STORAGE : LIMITS.partMaxBytes), `${f.filename} ${f.bytes}`);
      fs.writeFileSync(path.join(dir, 'recomendado.mbz'), linked);
      for (const f of result.selfContained.files) {
        const row = store.rows.find((x) => x.id === f.artifactId);
        fs.writeFileSync(path.join(dir, f.filename), store.objects.get(row.storagePath));
      }
      // Referencia: el .mbz «de siempre» (todo adentro) — se arma solo para comparar (60/120 no caben en Storage).
      const ref = await B.buildDynamicMbzV3(input);
      const refV = await validateMain(ref.mbz, ref);
      assert(refV.ok, 'referencia válida');
      const refShape = await mbzShape(ref.mbz);
      fs.writeFileSync(path.join(dir, 'referencia.mbz'), ref.mbz);
      const facts = result.primary.built.expectations.facts;
      eq(facts.audio.audiobookSeconds, ref.expectations.facts.audio.audiobookSeconds, 'misma duración del audiolibro que la referencia');
      eq(result.media.reduce((s, m) => s + m.seconds, 0).toFixed(6), facts.audio.audiobookSeconds.toFixed(6), 'los MP3 en línea suman el audiolibro completo');
      eq(shape.byModname, refShape.byModname, 'mismas actividades que la referencia (el audiolibro es un label en ambos)');
      eq(shape.files, refShape.files - 1, 'recomendado: los mismos archivos que la referencia menos el MP3 único del audiolibro');
      ev.sizes = {
        referenciaBytes: ref.mbz.length,
        recomendadoBytes: linked.length,
        mediaEnLinea: result.media.map((m) => ({ file: m.file, bytes: m.bytes, seconds: Math.round(m.seconds) })),
        autocontenido: result.selfContained.files.map((f) => ({ archivo: f.filename, rol: f.role, bytes: f.bytes })),
      };
      ev.referencia = refShape;
      ev.recomendado = shape;
      ev.warnings = result.warnings;
      console.log(`   ${n} cap.: referencia ${(ref.mbz.length / MB).toFixed(1)} MiB · recomendado ${(linked.length / MB).toFixed(1)} MiB + ${result.media.length} MP3 en línea · autocontenido ${result.selfContained.files.map((f) => `${f.filename} ${(f.bytes / MB).toFixed(1)} MiB`).join(', ')}`);
    });
    if (!result) continue;

    await check(`D5 ${n} capítulos: corte a mitad de una subida en CADA paso → el reintento reutiliza lo subido y termina igual`, async () => {
      const total = store.uploads();
      const reusedRun = await S.deliverSplitV3(ctxFor(n, input, store));
      eq(store.uploads(), total, 'un reintento sin cambios no sube nada');
      eq(reusedRun.media.map((m) => m.url), result.media.map((m) => m.url), 'mismas direcciones duraderas');
      eq(reusedRun.selfContained.files.map((f) => [f.filename, f.sha256]), result.selfContained.files.map((f) => [f.filename, f.sha256]), 'mismos archivos');
      const cuts = [];
      // Todos los cortes hasta 30 capítulos; en los más grandes, el primero, uno del medio y el último (cada corte rearma todo).
      const ks = n <= 30 ? Array.from({ length: total }, (_, k) => k) : [...new Set([0, Math.floor(total / 2), total - 1])];
      for (const k of ks) {
        const s2 = R.memoryStore({ failAfterUploads: k });
        let crashed = false;
        try { await S.deliverSplitV3(ctxFor(n, input, s2)); } catch (e) { crashed = /SIMULATED_CRASH/.test(e.message); }
        assert(crashed, `corte ${k}: debía cortarse`);
        const before = s2.uploads();
        s2.failAfterUploads = null;
        const r2 = await S.deliverSplitV3(ctxFor(n, input, s2));
        eq(s2.uploads() - before, total - k, `corte tras ${k} subidas: el reintento sube solo lo que faltaba`);
        eq(r2.selfContained.files.map((f) => f.sha256).filter((_, i) => result.selfContained.files[i].role === 'audio'), result.selfContained.files.filter((f) => f.role === 'audio').map((f) => f.sha256), 'partes de audio idénticas (bytes determinísticos)');
        eq(r2.media.map((m) => m.sha256), result.media.map((m) => m.sha256), 'MP3 idénticos');
        for (const row of s2.rows) eq(sha256(s2.objects.get(row.storagePath)), row.checksumSha256, `objeto completo (${row.filename})`);
        cuts.push(k);
      }
      let lost = 0;
      const s3 = R.memoryStore();
      try { await S.deliverSplitV3(ctxFor(n, input, s3, { isLeaseLost: () => ++lost > 3 })); } catch (e) { assert(e instanceof S.LeaseLostError, e.message); }
      assert(lost > 3, 'lease perdida detiene la entrega sin error de producto');
      ev.interrupciones = { subidasPorEntrega: total, cortesProbados: cuts.length };
    });

    await check(`D6 ${n} capítulos: integridad de descarga (sha256 = resumen, CRC de cada entrada del zip)`, async () => {
      for (const f of result.selfContained.files) {
        const buf = fs.readFileSync(path.join(dir, f.filename));
        eq(sha256(buf), f.sha256, `${f.filename} sha256`);
        assert((await zipIntegrity(buf)) > 0, `${f.filename} sin entradas`);
      }
      assert((await zipIntegrity(fs.readFileSync(path.join(dir, 'recomendado.mbz')))) > 0, 'recomendado');
      for (const m of result.media) {
        const row = store.rows.find((x) => x.id === m.artifactId);
        eq(sha256(store.objects.get(row.storagePath)), m.sha256, `${m.file} sha256`);
      }
      const mediaSha1 = result.media.map((m) => crypto.createHash('sha1').update(store.objects.get(store.rows.find((x) => x.id === m.artifactId).storagePath)).digest('hex'));
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ mode: result.mode, summary: result.summary, warnings: result.warnings, mediaSha1 }, null, 1));
    });
    input = null;
    if (global.gc) global.gc();
  }

  await check('D7 dirección duradera: 302 a una URL firmada NUEVA en cada pedido; clave/archivo/tipo incorrectos → 404; revocado → 410; firma vencida no aplica', async () => {
    const key = CM.newMediaKey();
    const id = crypto.randomUUID();
    let signs = 0;
    const rows = { [id]: { id, owner_id: 'o', filename: 'audiolibro_modulo_01_cap_01-05.mp3', metadata: { mediaKey: key } } };
    const ds = { query: async (_sql, [aid, type]) => (type === 'dynamic_media_audio' && rows[aid] ? [rows[aid]] : []) };
    const arts = { getDownloadUrl: async () => ({ url: `https://x.supabase.co/storage/v1/object/sign/cursia-artifacts/p?token=t${++signs}` }) };
    const svc = new CM.CourseMediaService(ds, arts);
    const a = await svc.resolve(id, key, 'audiolibro_modulo_01_cap_01-05.mp3');
    const b = await svc.resolve(id, key, 'audiolibro_modulo_01_cap_01-05.mp3');
    assert(a.ok && b.ok && a.url !== b.url && a.ttlSeconds >= 300, 'cada pedido firma de nuevo');
    eq((await svc.resolve(id, CM.newMediaKey(), 'audiolibro_modulo_01_cap_01-05.mp3')).status, 404, 'clave incorrecta');
    eq((await svc.resolve(id, key, 'otro.mp3')).status, 404, 'archivo incorrecto');
    eq((await svc.resolve(crypto.randomUUID(), key, 'audiolibro_modulo_01_cap_01-05.mp3')).status, 404, 'id inexistente');
    eq((await svc.resolve('../etc', key, 'x.mp3')).status, 404, 'id inválido');
    rows[id].metadata.mediaRevokedAt = '2026-10-26T00:00:00Z';
    eq((await svc.resolve(id, key, 'audiolibro_modulo_01_cap_01-05.mp3')).status, 410, 'revocado');
    assert([...svc.brokenCounts.keys()].length >= 3, 'monitoreo de direcciones rotas');
    eq(CM.publicMediaBaseUrl({ PUBLIC_MEDIA_BASE_URL: 'https://api-staging.cursia.nomaddi.com/' }), 'https://api-staging.cursia.nomaddi.com', 'base');
    eq(CM.publicMediaBaseUrl({}), null, 'sin base → sin entrega en línea');
    let e = null;
    try { CM.publicMediaBaseUrl({ PUBLIC_MEDIA_BASE_URL: 'http://inseguro' }); } catch (x) { e = x.message; }
    assert(e, 'http rechazado');
  });

  await check('D7b sin PUBLIC_MEDIA_BASE_URL: la entrega es solo autocontenida (principal = dynamic_mbz) y sigue siendo válida', async () => {
    const input = R.largeCourseInput(dist, 60, { minutesPerChapter: 21 });
    const store = R.memoryStore();
    const r = await S.deliverSplitV3(ctxFor('60b', input, store, { publicMediaBase: null }));
    eq([r.mode, r.media.length], ['parts', 0], 'modo');
    assert(r.selfContained.totalFiles > 1 && r.selfContained.files[0].artifactId === '(dynamic_mbz)', 'el principal es el paquete del job');
  });

  if (MOODLE) {
    const MS = path.join(os.homedir(), 'cursia-test-env/work/r74/moodle.sh');
    const run = (target, args) => {
      const r = spawnSync('/bin/bash', [MS, target, ...args], { encoding: 'utf8', maxBuffer: 512 * MB, timeout: 3600000 });
      if (r.status !== 0) throw new Error(`${target} ${args.join(' ')} → ${r.status}: ${(r.stderr || '').slice(-1500)}${(r.stdout || '').slice(-500)}`);
      if (/(PHP )?(Warning|Fatal error|Exception):/i.test(r.stderr || '')) throw new Error(`avisos de PHP: ${(r.stderr || '').slice(-1500)}`);
      return r.stdout;
    };
    const restoreNew = (t, f) => Number(/Course ID: (\d+)/.exec(run(t, ['--action=restore-new', `--file=${f}`, '--categoryid=1']))[1]);
    const inspect = (t, id) => JSON.parse(run(t, ['--action=inspect', `--courseid=${id}`]));
    const structure = (d) => d.sections.map((s) => [s.num, s.name, s.cms.map((c) => [c.modname, c.idnumber])]);
    const created = [];
    for (const n of SIZES) {
      const dir = path.join(OUT, `c${n}`);
      const res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
      const ev = evidence.courses[n];
      await check(`D8 ${n} capítulos en Moodle 4.5: recomendado (1 archivo) y autocontenido restaurados = referencia; portabilidad a una segunda instancia limpia`, async () => {
        const t0 = Date.now();
        const refId = restoreNew('local', path.join(dir, 'referencia.mbz'));
        const tRef = Date.now() - t0;
        created.push(['local', refId]);
        const ref = inspect('local', refId);
        const t1 = Date.now();
        const recId = restoreNew('local', path.join(dir, 'recomendado.mbz'));
        const tRec = Date.now() - t1;
        created.push(['local', recId]);
        const rec = inspect('local', recId);
        const files = res.summary.selfContained.files;
        const t2 = Date.now();
        const scId = restoreNew('local', path.join(dir, files[0].filename));
        created.push(['local', scId]);
        const scBefore = inspect('local', scId);
        for (const f of files.slice(1)) run('local', ['--action=restore-merge', `--file=${path.join(dir, f.filename)}`, `--courseid=${scId}`]);
        const tSc = Date.now() - t2;
        const sc = inspect('local', scId);
        // Referencia vs recomendado: misma estructura completa (el audiolibro es el mismo label, sin MP3 adentro).
        eq(structure(rec), structure(ref), 'recomendado: mismas secciones y actividades, en el mismo orden, que la referencia');
        eq(rec.files.count, ref.files.count - 1, 'recomendado: todos los archivos menos el MP3 único del audiolibro');
        eq(rec.files.sha1Mismatch + sc.files.sha1Mismatch + ref.files.sha1Mismatch, 0, 'sha1 de cada archivo en disco = files.xml');
        const players = rec.audioPlayers.find((p) => p.idnumber === 'cv3:shell:audiobook');
        eq(players.srcs.filter((u) => u.startsWith(`${BASE_URL}/api/v1/media/`)).sort(), res.summary.media.map((m) => m.url).sort(), 'recomendado: los reproductores llevan las direcciones duraderas tras format_text');
        // Autocontenido: todo lo de la referencia + el audiolibro por módulo dentro de Moodle.
        const refMp3 = ref.mp3.filter((m) => m.filename === 'audiolibro.mp3');
        eq(refMp3.length, 1, 'referencia con el MP3 único');
        const segMp3 = sc.mp3.filter((m) => /^audiolibro_modulo_/.test(m.filename));
        eq(segMp3.length, res.summary.media.length, 'autocontenido: un MP3 por segmento (módulo)');
        eq(segMp3.map((m) => m.sha1).sort(), [...res.mediaSha1].sort(), 'autocontenido: cada MP3 restaurado tiene el sha1 del MP3 en línea (mismo audio en ambas versiones)');
        eq(segMp3.reduce((s, m) => s + m.bytes, 0), res.summary.media.reduce((s, m) => s + m.bytes, 0), 'autocontenido: mismos bytes de audio que los MP3 en línea');
        const nonAudio = (d) => structure(d).map(([num, name, cms]) => [num, name, cms.filter(([, idn]) => !/^cv3:audiobook_part:/.test(idn) && idn !== 'cv3:shell:audiobook')]);
        eq(nonAudio(sc), nonAudio(ref), 'autocontenido: mismas secciones y actividades que la referencia (fuera del audiolibro)');
        eq(sc.files.count, files.length === 1 ? ref.files.count : ref.files.count - 1 + segMp3.length, 'autocontenido: todos los archivos (audiolibro por módulo)');
        if (files.length > 1) {
          eq(sc.activities - scBefore.activities, segMp3.length, 'cada parte combinada agrega sus labels de audio');
          eq(sc.sections.map((s) => s.name), scBefore.sections.map((s) => s.name), 'combinar no cambia las secciones');
          eq(sc.fullname, scBefore.fullname, 'combinar no cambia el curso');
          const s1 = sc.sections[1].cms.map((c) => c.idnumber);
          eq(s1.slice(s1.indexOf('cv3:shell:audiobook') + 1).length, segMp3.length, 'los audios quedan justo debajo del label Audiolibro');
        }
        // Portabilidad: copia nativa de Moodle del autocontenido → OTRA instancia limpia (m405).
        const backup = path.join(dir, 'copia-nativa-moodle.mbz');
        run('local', ['--action=backup', `--courseid=${scId}`, `--out=${backup}`]);
        const portId = restoreNew('m405', backup);
        created.push(['m405', portId]);
        const port = inspect('m405', portId);
        eq(structure(port), structure(sc), 'segunda instancia: misma estructura');
        eq([port.files.count, port.files.bytes, port.files.sha1Mismatch], [sc.files.count, sc.files.bytes, 0], 'segunda instancia: mismos archivos y bytes');
        eq(port.mp3.map((m) => m.sha1).sort(), sc.mp3.map((m) => m.sha1).sort(), 'segunda instancia: mismos MP3 (sha1)');
        // El recomendado también se copia a otra instancia: las direcciones duraderas viajan intactas.
        const backup2 = path.join(dir, 'copia-nativa-recomendado.mbz');
        run('local', ['--action=backup', `--courseid=${recId}`, `--out=${backup2}`]);
        const port2Id = restoreNew('m405', backup2);
        created.push(['m405', port2Id]);
        const port2 = inspect('m405', port2Id);
        eq(structure(port2), structure(rec), 'segunda instancia (recomendado): misma estructura');
        eq(port2.audioPlayers.find((p) => p.idnumber === 'cv3:shell:audiobook').srcs.sort(), players.srcs.sort(), 'segunda instancia: mismas direcciones duraderas');
        ev.moodle = {
          referencia: { activities: ref.activities, byModname: ref.countsByModname, files: ref.files.count, fileBytes: ref.files.bytes, mp3: ref.mp3.length, restoreSeconds: Math.round(tRef / 1000) },
          recomendado: { activities: rec.activities, byModname: rec.countsByModname, files: rec.files.count, fileBytes: rec.files.bytes, audioLinks: players.srcs.length, restoreSeconds: Math.round(tRec / 1000) },
          autocontenidoAntesDeCombinar: { activities: scBefore.activities, files: scBefore.files.count, fileBytes: scBefore.files.bytes },
          autocontenido: { archivos: files.length, activities: sc.activities, byModname: sc.countsByModname, files: sc.files.count, fileBytes: sc.files.bytes, mp3: sc.mp3.length, restoreSeconds: Math.round(tSc / 1000) },
          segundaInstancia: { autocontenido: { activities: port.activities, files: port.files.count, fileBytes: port.files.bytes, mp3: port.mp3.length, copiaNativaBytes: fs.statSync(backup).size }, recomendado: { activities: port2.activities, audioLinks: port2.audioPlayers.find((p) => p.idnumber === 'cv3:shell:audiobook').srcs.length } },
        };
      });
    }
    for (const [t, id] of created) {
      try { run(t, ['--action=delete', `--courseid=${id}`, '--title=Atención al cliente']); } catch (e) { console.log(`   (limpieza ${t} ${id}: ${e.message.slice(0, 120)})`); }
    }
  }

  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 1));
  console.log(`\n${passes} ok, ${failures} fallos — evidencia: ${path.join(OUT, 'evidence.json')}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
