#!/usr/bin/env node
/* eslint-disable */
// r63 (V1) — el informe de calidad del paquete recibe los hallazgos que ya existen (batería Q1–Q9, alineación A1–A7,
// coherencia C1–C7) en MODO OBSERVACIÓN.
//
//   [o1] worker v3 real (fakes de DB/Storage): el informe trae `observation` versionado y hallazgos Q4 / C4 / alineación;
//   [o2] severidades acotadas: ningún hallazgo de observación es BLOCKER ni MAJOR ni blocksDelivery; Q1/Q6/A1 críticos
//        → INFO «verificado»; el resto de BLOCKER/MAJOR → MINOR; la severidad original queda registrada;
//   [o3] los campos de siempre del informe (counts, blocksDelivery, requiresHumanResolution, needsHumanReview,
//        notMeasured, hallazgos base) son IDÉNTICOS a los de un informe sin observación; el tope del resumen sigue
//        priorizando BLOCKER y MAJOR;
//   [o4] .mbz byte a byte igual con y sin el cambio (sha256): observación activa / observación que lanza / baseline
//        (dist de origin/staging, si se pasa --baseline=<dist>);
//   [o5] un adaptador (o la función entera, o los sidecars) que lanza → el paquete sale igual, el job completa y queda
//        un INFO `QUALITY_OBSERVATION_NOT_EVALUATED` (measured:false);
//   [o6] paquetes viejos no se recalculan: un .mbz reutilizado conserva su informe tal cual (sin `observation`).
//
// Sin red (http/https/net/tls/fetch prohibidos), sin IA, USD 0.
// Usage: npm run build && node scripts/check-r63-quality-report-findings.js [dist] [--baseline=<dist de origin/staging>]

const path = require('path');
const crypto = require('crypto');
const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}
require('reflect-metadata');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist'));
const baselineArg = args.find((a) => a.startsWith('--baseline='));
const baselineDist = baselineArg ? path.resolve(process.cwd(), baselineArg.slice('--baseline='.length)) : process.env.R63_BASELINE_DIST ? path.resolve(process.env.R63_BASELINE_DIST) : null;
const L = (root, rel) => require(path.join(root, rel));
const W = L(distRoot, 'workers/dynamic-package-worker.js');
const QR = L(distRoot, 'modules/quality/course-quality-report.js');
const QF = L(distRoot, 'modules/quality/quality-finding.js');
const OB = L(distRoot, 'modules/quality/package-observation.js');
const PF = require('./lib/v21-packaging-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BASE_KEYS = ['reportVersion', 'formatVersion', 'checksVersion', 'counts', 'blocksDelivery', 'requiresHumanResolution', 'needsHumanReview', 'notMeasured', 'deliveryRule'];
const baseView = (r) => ({ ...Object.fromEntries(BASE_KEYS.map((k) => [k, r[k]])), findings: r.findings.filter((f) => !f.observation) });

// ─── Fixture: curso v3 con contexto académico (RA2 ajeno al texto → Q4) y sidecars (conceptos ajenos al objetivo → C4) ───
function fixture(root) {
  const SF = require('./lib/v21-shell-fixtures');
  const SNAP = L(root, 'modules/course-blueprints/blueprint-snapshot.js');
  const MB = L(root, 'modules/generation-manifests/generation-manifest-builder.js');
  const base = SF.course2(root, { engine: 'h5p', finalExam: true, courseId: 631 });
  const snap = JSON.parse(JSON.stringify(base.snapshot));
  snap.course.academicContext = {
    version: 1, contextSha256: 'a'.repeat(64), subjectName: null,
    outcomes: [
      { id: 'RA1', text: 'Aplicar el protocolo de atención de reclamos con clientes', level: 'aplicar', domain: 'do' },
      { id: 'RA2', text: 'Calcular la entropía cuántica de agujeros negros rotantes', level: 'aplicar', domain: 'do' },
    ],
    competencies: [{ id: 'CO1', text: 'Comunicación efectiva con clientes' }],
  };
  for (const m of snap.modules) for (const c of m.chapters) { c.outcomeIds = ['RA1', 'RA2']; c.objective = 'Aplicar el protocolo de atención de reclamos con clientes insatisfechos'; }
  const snapshot = SNAP.recanonicalizeBlueprintSnapshotV2(snap);
  const source = { ...base.source, blueprintSha256: SNAP.snapshotSha256V2(snapshot) };
  const manifest = MB.buildGenerationManifestV3(snapshot, source);
  return PF.packagingInput(root, { engine: 'h5p', finalExam: true, courseId: 631, snapshot, manifest });
}

function worker(root, Wmod, fx, opts = {}) {
  const manifest = fx.manifest;
  const RUN_ID = '11111111-1111-4111-8111-111111111111';
  const OWNER = 'owner-r63';
  const artifacts = new Map();
  const rows = [];
  const sidecarRows = [];
  let n = 0;
  const addArt = (item, type, content, meta = {}, mime = 'application/json', into = rows) => {
    const id = `art-${String(++n).padStart(3, '0')}`;
    artifacts.set(id, { content, meta, mime });
    into.push({ item_key: item.key, item_run_id: `gir-${item.key}`, gir_status: 'completed', gir_type: item.type, output_summary: {}, artifact_id: id, artifact_type: type, storage_bucket: 'cursia-artifacts', storage_path: `${OWNER}/x/${id}`, mime_type: mime, artifact_status: null, metadata: meta });
  };
  const contentChapters = manifest.items.filter((i) => i.type === 'content').map((i) => i.chapterId);
  const plan = { chapters: Object.fromEntries(contentChapters.map((id, i) => [id, { concepts_introduced: [`concepto planeado ${i}`], concepts_assumed: [] }])) };
  for (const item of manifest.items) {
    const ch = item.chapterId;
    switch (item.type) {
      case 'course_plan': addArt(item, 'dynamic_course_plan_json', JSON.stringify(plan)); break;
      case 'course_intro': addArt(item, 'dynamic_course_intro_json', JSON.stringify(fx.contents.courseIntro)); break;
      case 'module_intro': addArt(item, 'dynamic_module_intro_json', JSON.stringify(fx.contents.moduleIntros.get(item.moduleId))); break;
      case 'content':
        addArt(item, 'dynamic_content_md', fx.contents.contentMd.get(ch), {}, 'text/markdown');
        addArt(item, 'dynamic_context_package_json', '{}');
        // Sidecar real (opcional, fuera de byItem): conceptos que no tienen nada que ver con el objetivo → C4.
        addArt(item, 'dynamic_context_summary_json', JSON.stringify({ chapterId: ch, summary: 'x', concepts_introduced: ['astrofísica estelar', 'mecánica orbital'], concepts_assumed: [], key_terms: ['astrofísica'] }), {}, 'application/json', sidecarRows);
        break;
      case 'experience': addArt(item, 'dynamic_experience_json', JSON.stringify(fx.contents.experiences.get(ch))); break;
      case 'presentation': addArt(item, 'dynamic_presentation', JSON.stringify({ fixture: true, provider: 'gamma', mode: 'mock', itemKey: item.key, chapterId: ch, slideCount: 7, pdfUrl: null, coverPngUrl: null }), { fixture: true, mock: true }); break;
      case 'audio_welcome':
      case 'audiobook_chapter': addArt(item, 'dynamic_audio_mp3', JSON.stringify({ fixture: true, provider: 'tts', mode: 'mock', durationSeconds: item.type === 'audio_welcome' ? 45 : 160 }), { fixture: true, mock: true }); break;
      case 'video': addArt(item, 'dynamic_video', JSON.stringify({ mode: 'real', delivery: 'youtube', videogenJobId: `vg-${ch}`, youtubeVideoId: PF.YOUTUBE_ID, youtubeUrl: `https://www.youtube.com/watch?v=${PF.YOUTUBE_ID}`, durationSec: PF.VIDEO_SECONDS })); break;
      case 'video_interactions': addArt(item, 'dynamic_video_interactions_json', JSON.stringify(fx.contents.videoInteractions.get(ch))); break;
      case 'activity': addArt(item, 'dynamic_h5p_params_json', JSON.stringify(fx.contents.activities.get(ch).payload)); break;
      case 'exam': addArt(item, 'dynamic_exam_gift', fx.contents.examGift.get(item.moduleId), {}, 'text/plain'); break;
      case 'final_exam': addArt(item, 'dynamic_exam_gift', fx.contents.finalExamGift, {}, 'text/plain'); break;
      default: throw new Error(`tipo sin fixture ${item.type}`);
    }
  }
  const state = { completed: [], failed: [], uploads: [], ledger: [], dynamicMbz: [], storage: new Map(), sidecarQueries: 0 };
  const runRow = { id: RUN_ID, owner_id: OWNER, execution_mode: 'dynamic_generation', worker_status: 'completed', status: 'completed', input_payload: { videoMode: 'real', videoDelivery: 'youtube', providerModes: { presentation: 'mock', audio: 'mock' } } };
  const ds = {
    async query(sql, params) {
      if (/set status = 'completed'/.test(sql)) { state.completed.push(JSON.parse(params[2])); return [{ id: params[0] }]; }
      if (/set status = 'failed'/.test(sql)) { state.failed.push(params[2]); return []; }
      if (/set lease_until = now\(\)/.test(sql)) return [{ id: params[0] }];
      if (/from public\.course_profiles/.test(sql)) return [];
      if (/from public\.courses where id = \$1/.test(sql)) return [{ metadata: {} }];
      if (/a\.type = 'dynamic_context_summary_json'/.test(sql)) {
        state.sidecarQueries++;
        if (opts.sidecarSqlThrows) throw new Error('relation "artifacts" timeout (fake)');
        return sidecarRows;
      }
      if (/generation_item_runs/.test(sql)) return rows;
      if (/from public\.production_jobs where id = \$1/.test(sql)) return [runRow];
      if (/to_regclass/.test(sql)) return [{ bp: true, us: true, inst: true }];
      if (/from public\.user_settings/.test(sql)) return [];
      throw new Error(`SQL no esperado en el fake: ${sql.slice(0, 80)}`);
    },
  };
  const deps = {
    dataSource: ds,
    artifacts: {
      async findAll(owner, f) { return f.type === 'dynamic_mbz' ? state.dynamicMbz : []; },
      async uploadBufferArtifact(i) {
        const a = { id: `mbz-${state.uploads.length + 1}`, metadata: i.metadata, storageBucket: 'cursia-artifacts', storagePath: i.storagePath, checksumSha256: sha(i.buffer) };
        state.uploads.push(i); state.dynamicMbz.push(a); state.storage.set(i.storagePath, i.buffer); return a;
      },
      async downloadStorageObject(bucket, p) { const b = state.storage.get(p); if (!b) throw new Error(`404 ${bucket}/${p}`); return b; },
    },
    manifests: { async getById() { return { id: 9001, sha256: 'manifest-sha', manifest }; } },
    blueprints: {
      async getByNumber() { throw new Error('v3 no usa getByNumber'); },
      async getByNumberAnySchema() { return { schemaVersion: 2, snapshot: fx.blueprint }; },
    },
    buildPlan: () => { throw new Error('v3 no usa el plan v1/v2'); },
    resolveArtifacts: () => { throw new Error('v3 no usa el resolver v1/v2'); },
    loadText: () => { throw new Error('v3 no usa loadText v1/v2'); },
    parseVideo: () => { throw new Error('v3 no usa parseVideo v1/v2'); },
    buildMbz: () => { throw new Error('v3 no usa el builder v1/v2'); },
    logger: { log() {}, warn() {}, error() {} },
    workerId: 'w1',
    leaseSeconds: 600,
    heartbeatMs: 3600000,
    finops: { async recordZero(e) { state.ledger.push(e); return { inserted: true }; } },
    loadersV3: () => ({
      loadText: async (a) => artifacts.get(a.artifactId).content,
      loadBytes: async () => { throw new Error('los audios del fixture son mock (JSON)'); },
      loadStorageBytes: async () => { throw new Error('las presentaciones del fixture son mock'); },
    }),
    nowSeconds: () => 1790600000,
    ...(opts.deps || {}),
  };
  const job = { id: 'job-r63', owner_id: OWNER, course_id: manifest.source.courseId, frontend_course_id: null, worker_status: 'running', status: 'running', input_payload: { runId: RUN_ID, manifestId: 9001, blueprintNumber: 1, packageKind: 'qa_preview' }, output_summary: {}, attempt_count: 1, max_attempts: 3 };
  return { deps, job, state, run: () => Wmod.processItem(deps, job) };
}

async function runOnce(opts = {}, root = distRoot, Wmod = W) {
  const h = worker(root, Wmod, fixture(root), opts);
  await h.run();
  eq(h.state.failed, [], 'el job no falla');
  eq(h.state.uploads.length, 1, 'un upload');
  return { h, s: h.state.completed[0], mbzSha: sha(h.state.uploads[0].buffer), meta: h.state.uploads[0].metadata };
}

(async () => {
  const active = await runOnce();
  const obsFindings = (r) => r.findings.filter((f) => f.observation);

  await check('[o1] el informe del paquete trae los hallazgos de observación (Q4, C4, alineación) con versión', async () => {
    const r = active.s.qualityReport;
    assert(r && r.observation, `informe con observation: ${JSON.stringify(r && Object.keys(r))}`);
    eq([r.observation.rulesVersion, r.observation.mode], [OB.QUALITY_OBSERVATION_RULES_VERSION, 'observation'], 'versión y modo');
    eq(Object.keys(r.observation.sources).sort(), ['alignment', 'content_rules', 'quality_battery'], 'tres fuentes');
    for (const [k, v] of Object.entries(r.observation.sources)) eq(v.status, 'evaluated', `fuente ${k} evaluada (${v.reason || ''})`);
    const codes = new Set(obsFindings(r).map((f) => f.code));
    assert(codes.has('Q4_OUTCOME_NOT_REFLECTED'), `Q4 presente: ${[...codes].join(',')}`);
    assert(codes.has('COHERENCE_C4'), `C4 presente: ${[...codes].join(',')}`);
    assert(obsFindings(r).some((f) => f.observation.source === 'alignment'), `algún hallazgo de alineación: ${[...codes].join(',')}`);
    assert(obsFindings(r).every((f) => f.observation.rulesVersion === OB.QUALITY_OBSERVATION_RULES_VERSION && f.rule && f.rule.version), 'cada hallazgo lleva versión');
    eq(active.h.state.sidecarQueries, 1, 'una sola consulta de sidecars');
    // También en la metadata del .mbz (el reuse lo copia de ahí).
    eq(active.meta.qualityReport.observation.rulesVersion, OB.QUALITY_OBSERVATION_RULES_VERSION, 'metadata del .mbz');
  });

  await check('[o2] severidades acotadas: nunca BLOCKER/MAJOR ni blocksDelivery; Q1/Q6/A1 → INFO verificado; resto → MINOR', async () => {
    for (const f of obsFindings(active.s.qualityReport)) {
      assert(['MINOR', 'INFO'].includes(f.severity), `${f.code} con severidad ${f.severity}`);
      assert(f.blocksDelivery === false, `${f.code} no bloquea`);
      assert(['BLOCKER', 'MAJOR', 'MINOR', 'INFO'].includes(f.observation.originalSeverity), 'severidad original registrada');
    }
    // Unidad: productores que marcarían BLOCKER/MAJOR.
    const bp = fixture(distRoot);
    const res = OB.buildPackageObservationFindings({
      manifest: bp.manifest, blueprint: bp.blueprint, contents: bp.contents, artifactTypesByItem: {}, coursePlan: null, contextSummaries: null,
      runners: {
        battery: () => ({ version: 'qb-test', pass: false, summary: {}, checks: [
          { id: 'Q1', metric: 0, threshold: 1, pass: false, findings: [{ code: 'Q1_MISSING_ARTIFACT', severity: 'critical', message: 'falta x' }] },
          { id: 'Q6', metric: 0, threshold: 1, pass: false, findings: [{ code: 'Q6_CHAPTER_NOT_ASSESSED', severity: 'critical', message: 'cap sin evaluar' }, { code: 'Q6_EVIDENCE_NOT_IN_CHAPTER', severity: 'warning', message: 'evidencia' }] },
          { id: 'Q8', metric: 0, threshold: 1, pass: false, findings: [{ code: 'Q8_ARTIFACT_WITHOUT_ITEM', severity: 'critical', message: 'huérfano' }] },
        ] }),
        alignment: () => ({ available: true, findings: [
          { id: 'a1', rule: 'A1', severity: 'critical', outcomeIds: ['RA1'], chapterIds: [], moduleIds: [], message: 'RA sin capítulo', suggestion: 's', evidence: {} },
          { id: 'a3', rule: 'A3', severity: 'warning', outcomeIds: ['RA1'], chapterIds: [], moduleIds: [], message: 'sin práctica', suggestion: 's', evidence: {} },
        ] }),
      },
    });
    const sev = Object.fromEntries(res.findings.filter((f) => f.code !== 'QUALITY_OBSERVATION_NOT_EVALUATED').map((f) => [f.code, [f.severity, f.observation.originalSeverity, f.blocksDelivery]]));
    eq(sev, {
      Q1_MISSING_ARTIFACT: ['INFO', 'BLOCKER', false], Q6_CHAPTER_NOT_ASSESSED: ['INFO', 'BLOCKER', false], Q6_EVIDENCE_NOT_IN_CHAPTER: ['MINOR', 'MAJOR', false],
      Q8_ARTIFACT_WITHOUT_ITEM: ['MINOR', 'BLOCKER', false], A1: ['INFO', 'BLOCKER', false], A3: ['MINOR', 'MAJOR', false],
    }, 'tabla de severidades en observación');
    const rep = QR.assembleCourseQualityReport(res.findings, res.meta);
    eq([rep.counts.BLOCKER, rep.counts.MAJOR, rep.blocksDelivery, rep.requiresHumanResolution], [0, 0, false, false], 'el informe no bloquea ni pide resolución por observación');
    eq([rep.observation.counts.BLOCKER, rep.observation.counts.MAJOR], [0, 0], 'observación sin BLOCKER/MAJOR');
  });

  await check('[o3] campos de siempre idénticos a un informe sin observación; el tope prioriza BLOCKER/MAJOR', async () => {
    const r = active.s.qualityReport;
    const without = QR.courseQualityReportSummary(QR.assembleCourseQualityReport(r.findings.filter((f) => !f.observation)));
    eq(baseView(r), baseView(without), 'base del informe');
    assert(!('observation' in without), 'sin meta → informe de siempre (sin observation)');
    // Base primero, observación al final.
    const firstObs = r.findings.findIndex((f) => f.observation);
    assert(firstObs === -1 || r.findings.slice(firstObs).every((f) => f.observation), 'los de observación van después de los de siempre');
    // Tope: 70 hallazgos base (con MAJOR y BLOCKER) + 100 de observación → el resumen guarda los base primero.
    const mk = (code, severity, i) => QF.finding({ code, severity, layer: 'E3', location: { chapterId: `c${i}` }, evidence: `e${i}`, rule: { id: code, version: '1' }, cause: 'c', recommendation: 'r', kind: 'deterministic' });
    const base = [mk('X_BLOCK', 'BLOCKER', 0), ...Array.from({ length: 5 }, (_, i) => mk('X_MAJOR', 'MAJOR', i)), ...Array.from({ length: 64 }, (_, i) => mk('X_MINOR', 'MINOR', i))];
    const obs = Array.from({ length: 100 }, (_, i) => OB.asObservation(mk('Q2_DUPLICATE_PARAGRAPH', 'MINOR', i), 'quality_battery'));
    const meta = { rulesVersion: OB.QUALITY_OBSERVATION_RULES_VERSION, mode: 'observation', sources: { quality_battery: { status: 'evaluated', findings: 100 }, alignment: { status: 'evaluated', findings: 0 }, content_rules: { status: 'evaluated', findings: 0 } } };
    const sum = QR.courseQualityReportSummary(QR.assembleCourseQualityReport([...obs, ...base], meta));
    eq([sum.findings.length, sum.truncated], [QR.COURSE_QUALITY_SUMMARY_MAX_FINDINGS, 110], 'tope');
    eq(sum.findings.slice(0, 6).map((f) => f.severity), ['BLOCKER', 'MAJOR', 'MAJOR', 'MAJOR', 'MAJOR', 'MAJOR'], 'BLOCKER y MAJOR primero');
    assert(sum.findings.every((f) => !f.observation), 'con más de 60 base, ninguno de observación desplaza a uno base');
    eq(sum.observation.counts.MINOR, 100, 'los de observación se cuentan completos aunque el resumen los recorte');
    eq([sum.counts.BLOCKER, sum.counts.MAJOR, sum.counts.MINOR], [1, 5, 64], 'counts de siempre');
  });

  const throwing = await runOnce({ deps: { buildObservationFindings: () => { throw new Error('adaptador roto (prueba)'); } } });
  const sidecarFail = await runOnce({ sidecarSqlThrows: true });
  const loaderThrows = await runOnce({ deps: { loadObservationSidecars: async () => { throw new Error('sidecars rotos (prueba)'); } } });
  const malformed = await runOnce({ deps: { buildObservationFindings: () => ({ findings: [null], meta: { rulesVersion: OB.QUALITY_OBSERVATION_RULES_VERSION, mode: 'observation', sources: {} } }) } });

  await check('[o4] .mbz byte a byte igual con y sin el cambio (sha256)', async () => {
    eq([throwing.mbzSha, sidecarFail.mbzSha, loaderThrows.mbzSha, malformed.mbzSha], [active.mbzSha, active.mbzSha, active.mbzSha, active.mbzSha], 'mismo sha con observación activa / que lanza / sin sidecars / mal formada');
    if (baselineDist) {
      const WB = L(baselineDist, 'workers/dynamic-package-worker.js');
      const base = await runOnce({}, baselineDist, WB);
      eq(base.mbzSha, active.mbzSha, `sha del .mbz igual al de la baseline (${baselineDist})`);
      eq(base.s.qualityReport.observation, undefined, 'la baseline no tiene observación');
      eq(baseView(active.s.qualityReport), baseView(base.s.qualityReport), 'campos de siempre del informe iguales a la baseline');
      const strip = (s) => { const { qualityReport, ...rest } = s; return rest; };
      eq(strip(active.s), strip(base.s), 'resumen del job (sin el informe) igual a la baseline');
      eq(active.h.state.ledger, base.h.state.ledger, 'FinOps igual a la baseline');
      console.log(`   baseline ${baselineDist}: sha ${base.mbzSha.slice(0, 16)}…`);
    } else {
      console.log('   (sin --baseline: comparación contra origin/staging omitida)');
    }
    const z = await JSZip.loadAsync(active.h.state.uploads[0].buffer);
    assert(z.file('moodle_backup.xml'), 'es un .mbz');
  });

  await check('[o5] adaptador que lanza → el paquete sale igual, el job completa y queda INFO «no se pudo evaluar»', async () => {
    const strip = (s) => { const { qualityReport, ...rest } = s; return rest; };
    for (const [name, run] of [['función entera', throwing], ['SQL de sidecars', sidecarFail], ['cargador de sidecars', loaderThrows], ['hallazgo mal formado', malformed]]) {
      eq(strip(run.s), strip(active.s), `${name}: resumen del job igual`);
      eq(run.h.state.ledger, active.h.state.ledger, `${name}: FinOps igual`);
      const r = run.s.qualityReport;
      assert(r, `${name}: informe presente`);
      eq(baseView(r), baseView(active.s.qualityReport), `${name}: campos de siempre iguales`);
      const ne = obsFindings(r).filter((f) => f.code === 'QUALITY_OBSERVATION_NOT_EVALUATED');
      assert(ne.length >= 1 && ne.every((f) => f.severity === 'INFO' && f.measured === false && f.blocksDelivery === false), `${name}: INFO no evaluado: ${JSON.stringify(ne.map((f) => f.evidence))}`);
    }
    eq(Object.values(throwing.s.qualityReport.observation.sources).map((s) => s.status), ['not_evaluated', 'not_evaluated', 'not_evaluated'], 'función entera: tres fuentes no evaluadas');
    // Sin sidecars (SQL falla), el course_plan igual alimenta C1–C7; la batería y la alineación siguen evaluadas.
    const sf = sidecarFail.s.qualityReport.observation.sources;
    eq([sf.quality_battery.status, sf.alignment.status, sf.content_rules.status], ['evaluated', 'evaluated', 'evaluated'], 'SQL de sidecars: fuentes evaluadas con lo disponible');
    assert(obsFindings(sidecarFail.s.qualityReport).some((f) => f.code === 'QUALITY_OBSERVATION_NOT_EVALUATED' && /sidecars/.test(f.evidence)), 'SQL de sidecars: INFO con el motivo');
    // Unidad: una fuente que lanza no tumba a las otras.
    const fx = fixture(distRoot);
    const res = OB.buildPackageObservationFindings({ manifest: fx.manifest, blueprint: fx.blueprint, contents: fx.contents, artifactTypesByItem: {}, coursePlan: { chapters: {} }, contextSummaries: null, runners: { battery: () => { throw new Error('Q roto'); } } });
    eq([res.meta.sources.quality_battery.status, res.meta.sources.alignment.status, res.meta.sources.content_rules.status], ['not_evaluated', 'evaluated', 'evaluated'], 'aislamiento por fuente');
    assert(res.findings.some((f) => f.code === 'QUALITY_OBSERVATION_NOT_EVALUATED' && /Q roto/.test(f.evidence)), 'motivo registrado');
  });

  await check('[o6] paquetes viejos no se recalculan: el reutilizado conserva su informe tal cual', async () => {
    const h = active.h;
    const old = JSON.parse(JSON.stringify(h.state.dynamicMbz[0].metadata.qualityReport));
    delete old.observation;
    old.findings = old.findings.filter((f) => !f.observation);
    h.state.dynamicMbz[0].metadata = { ...h.state.dynamicMbz[0].metadata, qualityReport: old };
    h.state.completed.length = 0;
    const q0 = h.state.sidecarQueries;
    await h.run();
    eq([h.state.uploads.length, h.state.completed[0].reused], [1, true], 'reutilizado, sin rebuild');
    eq(h.state.completed[0].qualityReport, old, 'informe viejo intacto (sin observation)');
    eq(h.state.sidecarQueries, q0, 'no se vuelve a medir');
  });

  await check('netguard: ningún intento de red', async () => { eq(netAttempts, [], 'red'); });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
