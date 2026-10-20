#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * r61 (Q-24) — tamaño del paquete vs límite de subida del almacenamiento. Offline, USD 0, sin red.
 *
 *   P1 modelo calibrado con el .mbz real de #1353 (111.561.795 bytes; 12 capítulos de contenido + 3 de práctica)
 *   P2 tabla S/M/L (catálogo COURSE_FORMATS) contra 50 / 200 / 300 MB
 *   P3 modos mock → medios sintéticos, cabe en 50 MB
 *   P4 límite único: STORAGE_MAX_UPLOAD_BYTES (default 50 MB) lo usan la proyección Y el worker (packageSizeLimitsFromEnv)
 *   P5 RunsService.assertPackageSizeFits: 409 PACKAGE_SIZE_PROJECTED_OVER_LIMIT accionable; v1/v2 sin cambios; config inválida → 409
 *   P6 startRun / previewStart: el gate corre ANTES de crear el run (orden en el código) y solo para runs nuevos
 *   P7 end-to-end in-process: check-commercial-finops con 50 MB → startRun rechaza el curso de 9 capítulos sin crear el run
 *   P8 mensajes del worker accionables y clasificados como config retenida
 *   P9 in-process (resolveOrCreateRun): retomar el run activo nunca se bloquea; reabrir sobre el límite → 409 después de
 *      PROVIDER_MODES_CONFLICT y antes de cualquier gate de gasto; con palabras medidas cortas el reabrir pasa
 *   P10 el audiolibro escala con las palabras narrables (ratio 0,9/1,1 a 141 ppm); sin palabras, calibración #1353
 *
 * Uso: npm run build && node scripts/check-r61-package-size.js [dist] [--table]
 */
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const PJ = L('package/v3/package-size-projection.js');
const SZ = L('package/v3/package-size-budget.js');
const CF = L('modules/prebrief/course-formats.js');
const FC = L('modules/reliability/failure-classifier.js');
const { RunsService } = L('modules/dynamic-generation/runs.service.js');

let passes = 0;
let failures = 0;
const MB = 1024 * 1024;
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack || e}`); }
}

/** Items de un Manifest v3 equivalentes al builder: por capítulo de contenido content/presentation/audiobook_chapter. */
function manifestItems(contentChapters, practiceChapters = 0) {
  const items = [{ type: 'course_plan' }, { type: 'course_intro' }, { type: 'audio_welcome' }];
  for (let i = 0; i < contentChapters; i++) {
    const chapterId = `c${i}`;
    for (const type of ['content', 'experience', 'presentation', 'activity', 'audiobook_chapter']) items.push({ type, chapterId });
  }
  for (let i = 0; i < practiceChapters; i++) items.push({ type: 'application_activity', chapterId: `p${i}` });
  return items;
}
const REAL = { presentation: 'real', audio: 'real' };
const MOCK = { presentation: 'mock', audio: 'mock' };

(async () => {
  await check('P1 modelo calibrado con #1353 (111.561.795 B): esperado entre real y real+8 %, alto entre +20 % y +40 %', () => {
    const real = 111561795;
    const p = PJ.projectPackageSize(manifestItems(12, 3), REAL, { maxBytes: null });
    eq(p.counts, { contentChapters: 12, chapters: 15, audiobookChapters: 12, presentations: 12, audiobookChaptersWithWords: 0 }, 'conteos');
    console.log(`   #1353: real ${real} B · esperado ${p.expectedBytes} B (×${(p.expectedBytes / real).toFixed(3)}) · alto ${p.highBytes} B (×${(p.highBytes / real).toFixed(3)})`);
    assert(p.expectedBytes >= real && p.expectedBytes <= real * 1.08, `esperado ${PJ.mbText(p.expectedBytes)} vs real ${PJ.mbText(real)}`);
    assert(p.highBytes >= real * 1.2 && p.highBytes <= real * 1.4, `alto ${PJ.mbText(p.highBytes)}`);
    // El audiolibro domina (≈ 80 %), como en el paquete real (89,9 de 106,4 MB).
    assert(p.breakdown.audiobook / p.expectedBytes > 0.7, `audiolibro ${PJ.mbText(p.breakdown.audiobook)}`);
    eq(p.verdict, 'ok', 'sin límite = ok');
    // Si el .mbz real está a mano, el modelo también cuadra con lo medido.
    const local = path.join(process.env.HOME || '', 'Downloads/atencion-integral-en-salud-a-victimas-de-violencia-sexual-v3.mbz');
    if (fs.existsSync(local)) eq(fs.statSync(local).size, real, 'tamaño del .mbz local de #1353');
  });

  const table = [];
  const LIMITS = [['50MiB', 50 * MB], ['200MB', 200000000], ['300MB', 300000000]];
  await check('P2 S/M/L (bloqueo por el ALTO): 50 MiB bloquea todo; staging 200.000.000 B deja S/M y bloquea L; 300.000.000 B deja todo', () => {
    for (const code of CF.COURSE_FORMAT_CODES) {
      const f = CF.COURSE_FORMATS[code];
      const n = f.modules * f.chaptersPerModule;
      const row = { format: code, chapters: n };
      for (const [label, lim] of LIMITS) {
        const p = PJ.projectPackageSize(manifestItems(n, f.modules), REAL, { maxBytes: lim });
        row.expected = PJ.mbText(p.expectedBytes);
        row.high = PJ.mbText(p.highBytes);
        row[label] = p.verdict;
      }
      table.push(row);
    }
    eq(table.map((r) => [r.format, r.chapters]), [['S', 9], ['M', 12], ['L', 20]], 'catálogo');
    eq(table.map((r) => r['50MiB']), ['over', 'over', 'over'], '50 MiB');
    eq(table.map((r) => r['200MB']), ['ok', 'ok', 'over'], '200.000.000 B (staging)');
    eq(table.map((r) => r['300MB']), ['ok', 'ok', 'ok'], '300.000.000 B (recomendado)');
    // El curso más chico (capítulos de contenido, sin palabras) que ya no cabe en 50 MiB con audio real.
    let k = 1;
    while (PJ.projectPackageSize(manifestItems(k), REAL, { maxBytes: 50 * MB }).verdict !== 'over') k++;
    eq(k, 5, 'primer tamaño bloqueado en 50 MiB');
    // Aviso: el alto cabe pero el esperado está a < 10 % del límite.
    const m = PJ.projectPackageSize(manifestItems(12), REAL, { maxBytes: null });
    const near = PJ.projectPackageSize(manifestItems(12), REAL, { maxBytes: Math.max(m.highBytes, Math.ceil(m.expectedBytes / 0.9) - 1) });
    eq(near.verdict, m.highBytes < m.expectedBytes / 0.9 ? 'warn' : 'ok', 'aviso cerca del límite');
    const warnCase = PJ.projectPackageSize(manifestItems(12), REAL, { maxBytes: m.highBytes });
    eq([warnCase.verdict, warnCase.warnings.length], m.expectedBytes > m.highBytes * 0.9 ? ['warn', 1] : ['ok', 0], 'alto justo en el límite');
    if (process.argv.includes('--table')) console.table(table);
  });

  await check('P3 modos mock (QA): medios sintéticos → un L entra en 50 MB', () => {
    const p = PJ.projectPackageSize(manifestItems(20, 4), MOCK, { maxBytes: 50 * MB });
    eq(p.verdict, 'ok', `mock L ${PJ.mbText(p.expectedBytes)}`);
    const mixed = PJ.projectPackageSize(manifestItems(12), { presentation: 'real', audio: 'mock' }, { maxBytes: 50 * MB });
    eq(mixed.verdict, 'ok', `solo presentaciones reales ${PJ.mbText(mixed.expectedBytes)}`);
  });

  await check('P4 límite único: default 50 MB; STORAGE_MAX_UPLOAD_BYTES manda en worker y proyección; PACKAGE_MBZ_MAX_BYTES ≤ Storage', () => {
    eq(SZ.DEFAULT_STORAGE_MAX_UPLOAD_BYTES, 52428800, 'default = 50 MB de Supabase');
    eq(SZ.packageSizeLimitsFromEnv({}).maxBytes, 52428800, 'worker sin variable');
    const env = { STORAGE_MAX_UPLOAD_BYTES: String(200 * MB) };
    eq(SZ.packageSizeLimitsFromEnv(env), { warnBytes: Math.floor(200 * MB * 0.9), maxBytes: 200 * MB }, 'worker con Storage 200 MB');
    eq(SZ.packageSizeLimitsFromEnv({ ...env, PACKAGE_MBZ_MAX_BYTES: String(100 * MB) }).maxBytes, 100 * MB, 'tope propio del .mbz más bajo');
    eq(SZ.packageSizeLimitsFromEnv({ PACKAGE_MBZ_MAX_BYTES: String(40 * MB) }).maxBytes, 40 * MB, 'tope propio bajo el default');
    for (const bad of [{ ...env, PACKAGE_MBZ_MAX_BYTES: String(300 * MB) }, { PACKAGE_MBZ_MAX_BYTES: String(100 * MB) }, { STORAGE_MAX_UPLOAD_BYTES: '50MB' }, { STORAGE_MAX_UPLOAD_BYTES: '0' }]) {
      let err = null;
      try { SZ.packageSizeLimitsFromEnv(bad); } catch (e) { err = e.message; }
      assert(err && err.startsWith('PACKAGE_SIZE_CONFIG_INVALID:'), `${JSON.stringify(bad)} → ${err}`);
    }
  });

  const svc = Object.create(RunsService.prototype);
  const v3 = (n) => ({ rulesVersion: 3, manifest: { items: manifestItems(n) } });
  const withEnv = async (vars, fn) => {
    const prev = {};
    for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
  };
  const clean = { STORAGE_MAX_UPLOAD_BYTES: undefined, PACKAGE_MBZ_MAX_BYTES: undefined, PACKAGE_MBZ_WARN_BYTES: undefined };

  await check('P5 assertPackageSizeFits: 409 accionable con el alto sobre el límite; v1/v2 null; config inválida 409', async () => {
    await withEnv(clean, async () => {
      let body = null;
      try { await svc.assertPackageSizeFits(v3(12), REAL); } catch (e) { body = e.getResponse ? e.getResponse() : null; eq(e.getStatus(), 409, 'status'); }
      assert(body, 'debía rechazar M con 50 MB');
      eq(body.code, 'PACKAGE_SIZE_PROJECTED_OVER_LIMIT', 'código');
      for (const needle of ['No se generó nada', 'STORAGE_MAX_UPLOAD_BYTES', 'Upload file size limit', 'plan Pro', 'audiolibro', '50.0 MB', 'Opciones', 'EXACTO', 'menos capítulos']) {
        assert(body.message.includes(needle), `mensaje sin «${needle}»: ${body.message}`);
      }
      eq(body.packageSize.verdict, 'over', 'proyección en el cuerpo');
      eq(await svc.assertPackageSizeFits({ rulesVersion: 2, manifest: { items: manifestItems(12) } }, REAL), null, 'v2 sin cambios');
      eq((await svc.assertPackageSizeFits(v3(3), REAL)).verdict, 'ok', 'curso de 3 capítulos cabe en 50 MiB');
      eq((await svc.assertPackageSizeFits(v3(12), MOCK)).verdict, 'ok', 'M en mock cabe');
    });
    await withEnv({ ...clean, STORAGE_MAX_UPLOAD_BYTES: '200000000' }, async () => {
      const p = await svc.assertPackageSizeFits(v3(12), REAL);
      eq([p.verdict, p.limitBytes], ['ok', 200000000], 'M en staging cabe');
      let body = null;
      try { await svc.assertPackageSizeFits(v3(20), REAL); } catch (e) { body = e.getResponse(); }
      eq(body && body.code, 'PACKAGE_SIZE_PROJECTED_OVER_LIMIT', 'L en staging (200.000.000 B): el alto no cabe → 409');
    });
    await withEnv({ ...clean, STORAGE_MAX_UPLOAD_BYTES: 'mucho' }, async () => {
      let body = null;
      try { await svc.assertPackageSizeFits(v3(1), REAL); } catch (e) { body = e.getResponse(); }
      eq(body && body.code, 'PACKAGE_SIZE_CONFIG_INVALID', 'config inválida');
    });
  });

  await check('P6 orden en el código: run nuevo → gate antes del presupuesto e insertRun; reabrir → después de PROVIDER_MODES_CONFLICT, antes del gasto; previewStart también para reabribles', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/modules/dynamic-generation/runs.service.ts'), 'utf8');
    const ro = src.slice(src.indexOf('  private async resolveOrCreateRun('), src.indexOf('  private async resolveOrCreateRun(') + 9000);
    const reopenGate = ro.indexOf('await this.assertPackageSizeFits(manifest, runSpendModes(latestVideoMode, frozenProviderModesOf(latest.input_payload)), latest.id);');
    assert(reopenGate > ro.indexOf('code: PROVIDER_MODES_CONFLICT') && reopenGate > ro.indexOf('supersededConflict(latest.id') && reopenGate < ro.indexOf('this.enforceVideoGate(') && reopenGate < ro.indexOf('this.finopsPaidWorkGate(') && reopenGate < ro.indexOf('return this.reopenRun('), 'gate al reabrir mal ubicado');
    const newGate = ro.indexOf('await this.assertPackageSizeFits(manifest, runSpendModes(videoMode, providerModes ?? null));');
    assert(newGate > ro.indexOf('await this.assertNoPreviousItems(manifest);') && newGate < ro.indexOf('this.finopsStartGate(') && newGate < ro.indexOf('this.insertRun('), 'gate de run nuevo mal ubicado');
    assert(ro.indexOf('if (active) return this.existingRunOrConflict(') < reopenGate, 'el activo se devuelve antes de cualquier gate');
    const pv = src.slice(src.indexOf('  async previewStart('), src.indexOf('  /** Política + gasto del curso'));
    assert(/!isActive\(latest\) && isReopenable\(latest\)\s*\? await this\.assertPackageSizeFits\(/.test(pv), 'previewStart: reabrible evaluado');
    const g2 = pv.indexOf('const packageSize = await this.assertPackageSizeFits(');
    assert(g2 > 0 && g2 < pv.indexOf('this.finopsBudget.evaluateStart('), 'previewStart: gate antes del estimado');
    assert((pv.match(/packageSize/g) || []).length >= 5, 'previewStart devuelve packageSize (reabrible, sin FinOps, con FinOps)');
  });

  await check('P7 end-to-end in-process (check-commercial-finops, BD en memoria): con 50 MiB startRun rechaza los cursos reales sin crear el run; con 300.000.000 B pasa', () => {
    const script = path.resolve(__dirname, 'check-commercial-finops.js');
    const run = (lim) => spawnSync(process.execPath, [script, distRoot], { env: { ...process.env, STORAGE_MAX_UPLOAD_BYTES: String(lim) }, encoding: 'utf8', timeout: 300000 });
    const over = run(50 * MB);
    const out = `${over.stdout}\n${over.stderr}`;
    assert(over.status !== 0 && /startRun: PACKAGE_SIZE_PROJECTED_OVER_LIMIT: .*No se generó nada/.test(out), `esperaba el 409 de tamaño: ${out.slice(-600)}`);
    assert(!/budget_approval_required/.test(out.split('PACKAGE_SIZE_PROJECTED_OVER_LIMIT')[0].slice(-200)), 'el tamaño se evalúa antes del presupuesto');
    const ok = run(300000000);
    assert(ok.status === 0, `con 300.000.000 B debía pasar: ${(ok.stdout + ok.stderr).slice(-600)}`);
  });

  await check('P8 worker: mensaje de PACKAGE_SIZE_LIMIT_EXCEEDED accionable y clasificado como config retenida (USD 0 al reintentar)', async () => {
    const JSZip = require('jszip');
    const z = new JSZip();
    z.file('files.xml', '<files></files>');
    z.file('files/ab/' + 'a'.repeat(40), Buffer.alloc(4096, 7));
    const buf = await z.generateAsync({ type: 'nodebuffer' });
    const v = await SZ.packageSizeBudget(buf, { warnBytes: null, maxBytes: buf.length - 1 });
    for (const needle of ['PACKAGE_SIZE_LIMIT_EXCEEDED:', 'STORAGE_MAX_UPLOAD_BYTES', 'Upload file size limit', 'Preparar paquete', 'USD 0']) assert(v.error.includes(needle), `sin «${needle}»: ${v.error}`);
    const r = FC.classifyFailure({ error: v.error, source: 'package_worker' });
    eq([r.class, r.strategy, r.humanReason], ['D', 'hold_for_human', 'config'], 'clasificación');
  });

  // P9: resolveOrCreateRun in-process con stubs (sin DB): solo lo que el método toca antes del gasto.
  const items12 = manifestItems(12);
  const manifest12 = { id: 77, rulesVersion: 3, manifest: { items: items12 } };
  const REACHED = 'LLEGO_AL_GATE_DE_GASTO';
  function stubbed({ active = null, latest = null, words = [] } = {}) {
    const s = Object.create(RunsService.prototype);
    s.findActiveRunRow = async () => active;
    s.existingRunOrConflict = async (row) => ({ resumed: row.id });
    s.findLatestRunRow = async () => latest;
    s.loadContextRow = async () => ({ context_hash: 'h1', context: {} });
    s.findSupersedingRun = async () => null;
    s.dataSource = { query: async (sql) => (/audiobookPlan/.test(sql) ? words : []) };
    s.logger = { warn() {}, log() {}, error() {} };
    s.enforceVideoGate = async () => { throw new Error(REACHED); };
    s.finopsPaidWorkGate = async () => { throw new Error(REACHED); };
    s.reopenRun = async () => { throw new Error('NO_DEBE_REABRIR'); };
    s.hasPreviousItems = async () => false;
    s.assertNoPreviousItems = async () => {};
    s.finopsStartGate = async () => { throw new Error(REACHED); };
    return s;
  }
  const call = (s, providerModes = { presentation: 'real', audio: 'real' }) =>
    s.resolveOrCreateRun(1, 'owner', 1, manifest12, {}, 'h1', 'mock', true, 'youtube', providerModes, {});
  const codeOf = async (p) => { try { await p; return 'NO_THROW'; } catch (e) { return (e.getResponse && e.getResponse().code) || e.message; } };
  const frozenReal = { videoMode: 'mock', providerModes: { presentation: 'real', audio: 'real' } };

  await check('P9 in-process: retomar el run activo nunca se bloquea; reabrir sobre el límite → 409 (tras PROVIDER_MODES_CONFLICT, antes del gasto); run nuevo → 409 antes del presupuesto', async () => {
    await withEnv(clean, async () => {
      // Retomar: un M real con 50 MiB (proyección bloqueada) se devuelve igual.
      eq(await call(stubbed({ active: { id: 'act', worker_status: 'running', input_payload: frozenReal } })), { resumed: 'act' }, 'retomar activo');
      // Reabrir un run fallido de M real con 50 MiB → 409 de tamaño, sin llegar a ningún gate de gasto.
      const failed = { id: 'r-old', worker_status: 'failed', input_payload: frozenReal };
      eq(await codeOf(call(stubbed({ latest: failed }))), 'PACKAGE_SIZE_PROJECTED_OVER_LIMIT', 'reabrir sobre el límite');
      // Modos distintos de los congelados → el conflicto de modos gana (M3).
      eq(await codeOf(call(stubbed({ latest: failed }), { presentation: 'mock', audio: 'real' })), 'provider_modes_conflict', 'conflicto de modos primero');
      // Run nuevo (sin runs previos) → 409 antes de finopsStartGate.
      eq(await codeOf(call(stubbed())), 'PACKAGE_SIZE_PROJECTED_OVER_LIMIT', 'run nuevo sobre el límite');
      // Reabrir con palabras medidas cortas (400 por capítulo ≈ 2,6 min) → cabe → sigue al gate de video.
      const words = items12.filter((i) => i.type === 'audiobook_chapter').map((i) => ({ chapter_id: i.chapterId, words: '400' }));
      eq(await codeOf(call(stubbed({ latest: failed, words }))), REACHED, 'reabrir con palabras medidas que caben');
    });
    await withEnv({ ...clean, STORAGE_MAX_UPLOAD_BYTES: '200000000' }, async () => {
      eq(await codeOf(call(stubbed())), REACHED, 'run nuevo M con el límite de staging → sigue al presupuesto');
    });
  });

  await check('P10 audiolibro por palabras: 2.800 palabras → ≈ 17,9 / 21,8 min; sin palabras → 21 / 25 min; mezcla por capítulo', () => {
    const one = manifestItems(1);
    const byWords = PJ.projectPackageSize(one, REAL, { maxBytes: null }, { chapterWords: { c0: 2800 } });
    const none = PJ.projectPackageSize(one, REAL, { maxBytes: null });
    const min = (b) => b / 6000 / 60;
    assert(Math.abs(min(byWords.breakdown.audiobook) - (2800 * 0.9) / 141) < 0.01, `esperado ${min(byWords.breakdown.audiobook)}`);
    eq(none.breakdown.audiobook, 21 * 60 * 6000, 'fallback esperado 21 min');
    eq(byWords.counts.audiobookChaptersWithWords, 1, 'con palabras');
    const hiW = PJ.projectPackageSize(one, REAL, { maxBytes: 1 }, { chapterWords: { c0: 2800 } });
    assert(Math.abs(hiW.highBytes - hiW.expectedBytes - ((2800 * 0.2) / 141) * 60 * 6000 - (2.4 - 1.75 + 1.0 - 0.6 + 0.4 - 0.25 + 1.0) * MB) < 2, 'alto con ratio 1,1');
    const mixed = PJ.projectPackageSize(manifestItems(2), REAL, { maxBytes: null }, { chapterWords: { c0: 1410, x: 99999 } });
    eq(mixed.breakdown.audiobook, Math.round((1410 * 0.9 / 141 + 21) * 60 * 6000), 'un capítulo con palabras + uno sin');
  });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
