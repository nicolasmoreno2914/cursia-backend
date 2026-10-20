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
  await check('P1 modelo calibrado con #1353 (real 106,4 MB): esperado entre real y real+12 %, alto ≥ real', () => {
    const real = 111561795;
    const p = PJ.projectPackageSize(manifestItems(12, 3), REAL, { maxBytes: null });
    eq(p.counts, { contentChapters: 12, chapters: 15, audiobookChapters: 12, presentations: 12 }, 'conteos');
    assert(p.expectedBytes >= real && p.expectedBytes <= real * 1.12, `esperado ${PJ.mbText(p.expectedBytes)} vs real ${PJ.mbText(real)}`);
    assert(p.highBytes >= p.expectedBytes, 'alto ≥ esperado');
    // El audiolibro domina (≈ 80 %), como en el paquete real (89,9 de 106,4 MB).
    assert(p.breakdown.audiobook / p.expectedBytes > 0.7, `audiolibro ${PJ.mbText(p.breakdown.audiobook)}`);
    eq(p.verdict, 'ok', 'sin límite = ok');
    // Si el .mbz real está a mano, el modelo también cuadra con lo medido.
    const local = path.join(process.env.HOME || '', 'Downloads/atencion-integral-en-salud-a-victimas-de-violencia-sexual-v3.mbz');
    if (fs.existsSync(local)) eq(fs.statSync(local).size, real, 'tamaño del .mbz local de #1353');
  });

  const table = [];
  await check('P2 S/M/L: con 50 MB todos los formatos con audiolibro real se rechazan antes de generar; con 300 MB todos caben (L en 200 MB solo avisa)', () => {
    for (const code of CF.COURSE_FORMAT_CODES) {
      const f = CF.COURSE_FORMATS[code];
      const n = f.modules * f.chaptersPerModule;
      const row = { format: code, chapters: n };
      for (const lim of [50, 200, 300]) {
        const p = PJ.projectPackageSize(manifestItems(n, f.modules), REAL, { maxBytes: lim * MB });
        row.expected = PJ.mbText(p.expectedBytes);
        row.high = PJ.mbText(p.highBytes);
        row[`v${lim}`] = p.verdict;
      }
      table.push(row);
    }
    eq(table.map((r) => [r.format, r.chapters]), [['S', 9], ['M', 12], ['L', 20]], 'catálogo');
    eq(table.map((r) => r.v50), ['over', 'over', 'over'], '50 MB');
    eq(table.map((r) => r.v200), ['ok', 'ok', 'warn'], '200 MB (staging hoy)');
    eq(table.map((r) => r.v300), ['ok', 'ok', 'ok'], '300 MB (recomendado)');
    // El curso más chico que ya no cabe en 50 MB con audio real (capítulos de contenido).
    let k = 1;
    while (PJ.projectPackageSize(manifestItems(k), REAL, { maxBytes: 50 * MB }).verdict !== 'over') k++;
    eq(k, 6, 'primer tamaño sobre 50 MB');
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
    eq(SZ.storageUploadLimitFromEnv({}), 52428800, 'Storage sin variable');
    eq(SZ.packageSizeLimitsFromEnv({}).maxBytes, 52428800, 'worker sin variable');
    const env = { STORAGE_MAX_UPLOAD_BYTES: String(200 * MB) };
    eq(SZ.packageSizeLimitsFromEnv(env), { warnBytes: Math.floor(200 * MB * 0.9), maxBytes: 200 * MB }, 'worker con Storage 200 MB');
    eq(SZ.packageSizeLimitsFromEnv({ ...env, PACKAGE_MBZ_MAX_BYTES: String(100 * MB) }).maxBytes, 100 * MB, 'tope propio del .mbz más bajo');
    eq(SZ.packageSizeLimitsFromEnv({ PACKAGE_MBZ_MAX_BYTES: String(100 * MB) }).maxBytes, 100 * MB, 'tope propio sin Storage explícito (compatibilidad)');
    for (const bad of [{ ...env, PACKAGE_MBZ_MAX_BYTES: String(300 * MB) }, { STORAGE_MAX_UPLOAD_BYTES: '50MB' }, { STORAGE_MAX_UPLOAD_BYTES: '0' }]) {
      let err = null;
      try { SZ.packageSizeLimitsFromEnv(bad); } catch (e) { err = e.message; }
      assert(err && err.startsWith('PACKAGE_SIZE_CONFIG_INVALID:'), `${JSON.stringify(bad)} → ${err}`);
    }
  });

  const svc = Object.create(RunsService.prototype);
  const v3 = (n) => ({ rulesVersion: 3, manifest: { items: manifestItems(n) } });
  const withEnv = (vars, fn) => {
    const prev = {};
    for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
  };
  const clean = { STORAGE_MAX_UPLOAD_BYTES: undefined, PACKAGE_MBZ_MAX_BYTES: undefined, PACKAGE_MBZ_WARN_BYTES: undefined };

  await check('P5 assertPackageSizeFits: 409 accionable sobre el límite; aviso con el alto; v1/v2 null; config inválida 409', () => {
    withEnv(clean, () => {
      let body = null;
      try { svc.assertPackageSizeFits(v3(12), REAL); } catch (e) { body = e.getResponse ? e.getResponse() : null; eq(e.getStatus(), 409, 'status'); }
      assert(body, 'debía rechazar M con 50 MB');
      eq(body.code, 'PACKAGE_SIZE_PROJECTED_OVER_LIMIT', 'código');
      for (const needle of ['No se generó nada', 'STORAGE_MAX_UPLOAD_BYTES', 'Upload file size limit', 'plan Pro', 'audiolibro', '50.0 MB']) {
        assert(body.message.includes(needle), `mensaje sin «${needle}»: ${body.message}`);
      }
      eq(body.packageSize.verdict, 'over', 'proyección en el cuerpo');
      eq(svc.assertPackageSizeFits({ rulesVersion: 2, manifest: { items: manifestItems(12) } }, REAL), null, 'v2 sin cambios');
      eq(svc.assertPackageSizeFits(v3(3), REAL).verdict, 'ok', 'curso de 3 capítulos cabe en 50 MB');
      eq(svc.assertPackageSizeFits(v3(12), MOCK).verdict, 'ok', 'M en mock cabe');
    });
    withEnv({ ...clean, STORAGE_MAX_UPLOAD_BYTES: String(200 * MB) }, () => {
      const p = svc.assertPackageSizeFits(v3(20), REAL);
      eq([p.verdict, p.warnings.length, p.limitBytes], ['warn', 1, 200 * MB], 'L con 200 MB: aviso visible, no bloquea');
      assert(/^package_size_projected_high_over_limit:\d+:209715200$/.test(p.warnings[0]), p.warnings[0]);
    });
    withEnv({ ...clean, STORAGE_MAX_UPLOAD_BYTES: 'mucho' }, () => {
      let body = null;
      try { svc.assertPackageSizeFits(v3(1), REAL); } catch (e) { body = e.getResponse(); }
      eq(body && body.code, 'PACKAGE_SIZE_CONFIG_INVALID', 'config inválida');
    });
  });

  await check('P6 startRun / previewStart: el gate corre antes de crear el run, solo en runs nuevos; la vista previa devuelve packageSize', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/modules/dynamic-generation/runs.service.ts'), 'utf8');
    const start = src.slice(src.indexOf('  async startRun('), src.indexOf('  /** Prebrief: null si el curso no lo exige'));
    const gate = start.indexOf('if (!(await this.findActiveRunRow(manifest.id))) this.assertPackageSizeFits(manifest, runSpendModes(videoMode, providerModes ?? null));');
    assert(gate > 0, 'startRun sin el gate');
    assert(gate < start.indexOf('this.resolveOrCreateRun('), 'el gate debe ir antes de resolveOrCreateRun (antes de cualquier escritura)');
    const pv = src.slice(src.indexOf('  async previewStart('), src.indexOf('  /** Política + gasto del curso'));
    const g2 = pv.indexOf('const packageSize = this.assertPackageSizeFits(');
    assert(g2 > 0 && g2 < pv.indexOf('this.finopsBudget.evaluateStart('), 'previewStart: gate antes del estimado');
    assert(g2 > pv.indexOf('if (latest) {'), 'previewStart: un run existente se retoma sin re-evaluar el tamaño');
    assert((pv.match(/packageSize/g) || []).length >= 3, 'previewStart devuelve packageSize (con y sin FinOps)');
  });

  await check('P7 end-to-end in-process (check-commercial-finops, BD en memoria): con 50 MB startRun rechaza 9 capítulos reales sin crear el run; con 200 MB pasa', () => {
    const script = path.resolve(__dirname, 'check-commercial-finops.js');
    const run = (lim) => spawnSync(process.execPath, [script, distRoot], { env: { ...process.env, STORAGE_MAX_UPLOAD_BYTES: String(lim) }, encoding: 'utf8', timeout: 300000 });
    const over = run(50 * MB);
    const out = `${over.stdout}\n${over.stderr}`;
    assert(over.status !== 0 && /startRun: PACKAGE_SIZE_PROJECTED_OVER_LIMIT: .*No se generó nada/.test(out), `esperaba el 409 de tamaño: ${out.slice(-600)}`);
    assert(!/budget_approval_required/.test(out.split('PACKAGE_SIZE_PROJECTED_OVER_LIMIT')[0].slice(-200)), 'el tamaño se evalúa antes del presupuesto');
    const ok = run(200 * MB);
    assert(ok.status === 0, `con 200 MB debía pasar: ${(ok.stdout + ok.stderr).slice(-600)}`);
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

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
