#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.4 · Verificación del diseño antes de generar. Contra dist/. USD 0.
//
// Parte pura:
//   VF1 diseño sano: todo ok, sin bloqueo; costo, audiovisual, práctica y evaluaciones en la lista
//   VF2 horas: por encima → advertencia con «Usar N h»; no alcanza → editor; contenidos > horas → CRÍTICO (el botón
//       «Diseñar para N h» está en la tarjeta, no repetido aquí)
//   VF3 alineación: A1/A4 → «Corregir» automático SOLO si la vinculación lo resuelve (si no, editor con destino); A3/A5/A6
//       → «Ajustar» solo si cambia algo (si no, editor); A4 de un capítulo PROPUESTO se omite; el resumen no suma;
//       A7 / P2 → «Lo que entendimos»; sin resultados → advertencia; errores del Manifest → crítico sin códigos internos
//   VF6 contenidos del microcurrículo sin capítulo; evaluaciones que pide el documento; costo con coma decimal; > 500 h
//   VF8 contenidos cubiertos por UN capítulo (no por palabras sueltas del módulo); evaluaciones del documento por tipo y resultado
// Parte DB (Postgres 16 desechable; --pure-only la salta y lo dice):
//   VF4 la recomendación trae la verificación del MISMO diseño (alineación real del Coherence Engine)
//   VF9 aplicar: los capítulos de contenido que propone el diseño heredan los resultados de su módulo (sin A4 después)
//   VF10 «sin vínculos» solo al QUITARLOS; las sugerencias del panel académico no tocan prácticas ni desvinculados;
//        «Liberar» limpia las marcas de capítulos borrados
//   VF5 «Corregir» automático: vincula solo los capítulos de CONTENIDO SIN vínculos (los del docente y las prácticas
//       intactos), con vista previa en la verificación; un capítulo desvinculado a propósito no se re-vincula; sube el
//       contador; ya vinculado → la verificación no ofrece «automático»; contador viejo → 409; acción desconocida → 400; ajeno 404
//
// Uso: node scripts/check-loop84-verification.js [--pure-only] [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); }
}
const V = loadDist('modules/course-design/design-verification.js');
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const REC = loadDist('modules/course-design/design-recommendation.js');
const PP = loadDist('modules/pedagogy/pedagogy-profile.js');
const A = loadDist('modules/academic-context/index.js');
const F = require('./lib/academic-fixtures.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
async function rejectsRe(p, re, m, status) {
  try { await p; } catch (err) {
    const body = err && err.getResponse ? err.getResponse() : null;
    const text = [err && err.message, body && (typeof body === 'string' ? body : body.message || body.code)].filter(Boolean).join(' | ');
    assert(re.test(text), `${m}: error inesperado «${text}»`);
    if (status) eq(err.getStatus ? err.getStatus() : null, status, `${m}: status`);
    return;
  }
  throw new Error(`${m}: no falló`);
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function snapshot(videoAll = false) {
  const course = { id: 1, title: 'Curso', finalExam: true, activityEngine: 'h5p', reviewCards: false, academicContext: null };
  const modules = [0, 1].map((i) => ({ id: uuid(100 + i), position: i, title: `Módulo ${i + 1}`, objective: null, description: null, exam_enabled: true }));
  const chapters = [];
  modules.forEach((m, mi) => [0, 1, 2].forEach((ci) => chapters.push({ id: uuid(200 + mi * 10 + ci), module_id: m.id, position: ci, title: `Cap ${mi + 1}.${ci + 1}`, objective: 'Aplicar lo visto en un caso', description: null, video_enabled: videoAll, activity_enabled: true })));
  return SNAP.buildBlueprintSnapshotV2(course, modules, chapters);
}
const vids = (d) => d.modules.map((m) => m.chapters.filter((c) => c.kind === 'content').map((c) => (c.videoEnabled ? 1 : 0)).join(''));

(async () => {
  console.log('Parte pura');
  const base = { status: 'within_tolerance', targetHours: 64, estimatedHours: 63.5, toleranceHours: 3.2, baseHours: 30, counts: { modules: 4, chapters: 16, contentChapters: 12, practiceChapters: 4, videoChapters: 8, activities: 16, applicationActivities: 10, evaluations: 5 },
    manifestErrors: [], alignment: { available: true, coverage: { outcomes: 6, covered: 6, partial: 0, uncovered: 0 }, findings: [] }, approach: { id: 'competencias', label: 'Competencias' }, policyKind: 'application_first', audiovisual: 'recommended', pinnedChapters: 0, cost: { min: '18', expected: '24', max: '33' },
    preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, autoLink: { chapterIds: [], outcomeIds: [], preview: [] }, proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], uncoveredEvaluations: [] };
  const byId = (v) => Object.fromEntries(v.checks.map((c) => [c.id, c]));
  await check('VF1 diseño sano: todo ok y sin bloqueo; la lista cubre las 10 áreas', () => {
    const v = V.verifyDesign(base);
    eq([v.blocking, v.counts.critical, v.counts.warning], [false, 0, 0], 'sin problemas');
    const areas = [...new Set(v.checks.map((c) => c.area))].sort();
    eq(areas, ['activities', 'audiovisual', 'cost', 'evaluations', 'hours', 'outcomes', 'pedagogy', 'practice', 'structure'].sort(), 'áreas (consistencia solo aparece si falla)');
    eq(byId(v).hours.title, 'Carga horaria: 63,5 de 64 h de trabajo del estudiante', 'horas');
    eq(byId(v).audiovisual.title, '8 capítulos con video (recomendado)', 'audiovisual');
    assert(/USD 24/.test(byId(v).cost.title), 'costo');
  });
  await check('VF2 horas: encima → advertencia «Usar N h»; no alcanza → editor; contenidos > horas → crítico «Diseñar para N h»', () => {
    const above = byId(V.verifyDesign({ ...base, status: 'above_tolerance', estimatedHours: 69.2 })).hours;
    eq([above.severity, above.fix.kind, above.fix.value], ['warning', 'adjust', 70], 'encima');
    const cant = byId(V.verifyDesign({ ...base, status: 'cannot_reach_target', estimatedHours: 40 })).hours;
    eq([cant.severity, cant.fix.kind, cant.fix.action], ['warning', 'editor', 'add_modules'], 'no alcanza');
    const v = V.verifyDesign({ ...base, status: 'minimum_exceeds_target', targetHours: 16, baseHours: 30.2 });
    eq([byId(v).hours.severity, byId(v).hours.fix, /«Diseñar para 31 h» en la tarjeta/.test(byId(v).hours.detail), v.blocking], ['critical', undefined, true, true], 'contenidos > horas: bloquea; el botón está en la tarjeta (sin duplicar)');
  });
  await check('VF3 alineación → «Corregir» que de verdad resuelve: automático, Ajustar, editor o «Lo que entendimos»', () => {
    const f = (rule, severity, extra = {}) => ({ id: rule + ':x', rule, severity, outcomeIds: ['RA1'], chapterIds: [], moduleIds: [], message: 'm ' + rule, suggestion: 's', ...extra });
    const al = { available: true, outcomes: [{ id: 'RA1', status: 'uncovered', domain: 'do' }, { id: 'RA2', status: 'covered', domain: 'know' }, { id: 'CO1', status: 'partial', domain: 'competency' }], findings: [f('A1', 'critical'), f('A3', 'warning'), f('A6', 'warning'), f('A7', 'suggestion'), f('P2', 'suggestion'), f('A2', 'warning')] };
    const link = { chapterIds: [uuid(1)], outcomeIds: ['RA1'], preview: [{ chapter: 'Cap 1', outcomes: ['RA1'] }] };
    const vr = V.verifyDesign({ ...base, alignment: al, autoLink: link });
    const v = byId(vr);
    eq([v['alignment:A1:x'].fix.kind, v['alignment:A1:x'].fix.action, v.outcomes.severity, v.outcomes.title], ['auto', 'link_outcomes', 'critical', '1 de 2 resultados de aprendizaje con evidencia · 0 de 1 competencias'], 'A1 que la vinculación resuelve: automático');
    eq([v.outcome_links.severity, v.outcome_links.fix.kind, v.outcome_links.detail], ['info', 'auto', '«Cap 1» → RA1'], 'vista previa de lo que vincula Cursia');
    eq(vr.counts.critical, 1, 'el resumen de resultados no suma (solo el hallazgo A1)');
    // C1: la vinculación no alcanza a ESTE resultado → al editor (nunca un «automático» que no cambia nada).
    const other = byId(V.verifyDesign({ ...base, alignment: al, autoLink: { chapterIds: [uuid(1)], outcomeIds: ['RA9'], preview: [{ chapter: 'Cap 1', outcomes: ['RA9'] }] } }));
    eq([other['alignment:A1:x'].fix.kind, other['alignment:A1:x'].fix.action], ['editor', 'outcome_links'], 'A1 que la vinculación no resuelve: editor');
    eq(byId(V.verifyDesign({ ...base, alignment: al }))['alignment:A1:x'].fix.kind, 'editor', 'sin nada que vincular: editor');
    const onlyCo = byId(V.verifyDesign({ ...base, alignment: { available: true, outcomes: [{ id: 'RA1', status: 'covered', domain: 'do' }, { id: 'CO1', status: 'uncovered', domain: 'competency' }], findings: [f('A1c', 'warning')] } })).outcomes;
    eq(onlyCo.severity, 'warning', 'una competencia sin vincular es advertencia (no bloquea)');
    eq([v['alignment:A3:x'].fix.kind, v['alignment:A3:x'].fix.action, v['alignment:A3:x'].fix.value], ['adjust', 'emphasis', 'application'], 'A3: Más aplicación');
    eq(v['alignment:A6:x'].fix.kind, 'editor', 'A6 con actividades ya «donde el diseño las necesite»: editor (Ajustar no cambiaría nada)');
    const appl = byId(V.verifyDesign({ ...base, alignment: al, preferences: { emphasis: 'application', applicationActivities: 'none' } }));
    eq([appl['alignment:A3:x'].fix.kind, appl['alignment:A3:x'].fix.action, appl['alignment:A6:x'].fix.kind, appl['alignment:A6:x'].fix.value], ['editor', 'add_practice', 'adjust', 'auto'], 'I6: Ajustar solo si cambia algo');
    eq([v['alignment:A7:x'].fix.kind, v['alignment:P2:x'].fix.kind, v['alignment:A7:x'].severity], ['understood', 'understood', 'info'], 'A7/P2');
    eq(v['alignment:A2:x'].fix.action, 'module_exams', 'A2: evaluación del módulo');
    // I3: A4 de un capítulo que el diseño propone (todavía no existe) se omite; el de uno existente sin sugerencia va al editor con destino.
    const a4 = (ch) => f('A4', 'warning', { id: 'A4:' + ch, outcomeIds: [], chapterIds: [ch], moduleIds: [uuid(100)] });
    const p = byId(V.verifyDesign({ ...base, alignment: { available: true, outcomes: [{ id: 'RA1', status: 'covered', domain: 'do' }], findings: [a4(uuid(7)), a4(uuid(8))] }, proposedChapterIds: [uuid(7)] }));
    eq([!!p['alignment:A4:' + uuid(7)], p['alignment:A4:' + uuid(8)].fix.kind, p['alignment:A4:' + uuid(8)].fix.targets.chapterIds], [false, 'editor', [uuid(8)]], 'A4 propuesto omitido; existente al editor con destino');
    const none = byId(V.verifyDesign({ ...base, alignment: { available: false } })).outcomes;
    eq([none.severity, none.fix.kind], ['warning', 'understood'], 'sin resultados');
    const bad = V.verifyDesign({ ...base, manifestErrors: [{ code: 'DISTRIBUTION_MODEL_MISMATCH' }] });
    eq([byId(bad).consistency.severity, bad.blocking, /DISTRIBUTION/.test(byId(bad).consistency.detail)], ['critical', true, false], 'errores del Manifest bloquean, sin códigos internos');
    eq(byId(V.verifyDesign({ ...base, approach: null })).pedagogy.severity, 'warning', 'sin enfoque');
    eq(byId(V.verifyDesign({ ...base, counts: { ...base.counts, evaluations: 0 } })).evaluations.fix.action, 'module_exams', 'sin evaluaciones');
  });
  await check('VF6 contenidos sin capítulo; evaluaciones del documento; costo con coma; más de 500 h → dividir el curso', () => {
    const v = byId(V.verifyDesign({ ...base, uncoveredContents: ['Costeo ABC', 'Presupuesto maestro', 'Punto de equilibrio', 'Costeo variable'], counts: { ...base.counts, evaluations: 0 }, requiredEvaluations: ['Parcial', 'Proyecto final'], cost: { min: '18.5', expected: '24.75', max: '33.1' } }));
    eq([v.contents.severity, v.contents.fix.action, v.contents.detail], ['warning', 'add_chapter', '«Costeo ABC», «Presupuesto maestro», «Punto de equilibrio» y 1 más'], 'contenidos sin capítulo');
    eq(v.evaluations.detail, 'El microcurrículo pide evaluar con «Parcial», «Proyecto final».', 'evaluaciones del documento');
    eq(v.cost.title, 'Costo estimado de generar ≈ USD 24,75 (entre 18,5 y 33,1)', 'coma decimal');
    const big = byId(V.verifyDesign({ ...base, status: 'minimum_exceeds_target', targetHours: 400, baseHours: 612.3 })).hours;
    eq([big.severity, big.fix.kind, /500 h/.test(big.detail)], ['critical', 'editor', true], 'contenidos > 500 h: dividir');
    const above = byId(V.verifyDesign({ ...base, status: 'above_tolerance', targetHours: 480, estimatedHours: 500.4 })).hours;
    eq(above.fix.kind, 'editor', 'pasarse de 500 h no se ofrece como meta');
  });

  await check('VF8 contenidos: cubiertos por UN capítulo con ≥ 2 palabras en común; evaluaciones del documento por tipo y resultado', () => {
    const SVC = loadDist('modules/course-design/course-design.service.js');
    const ctx = { units: [{ contents: ['Hoja de costos por orden de producción', 'Costos indirectos de fabricación', 'Toma de decisiones con información de costos', 'Producción equivalente', 'Inventarios'].map((text) => ({ text })) }], evaluation: [] };
    // Sonda de la revisión L84-2 (N2): capítulos genéricos de un módulo «Contabilidad de costos» NO cubren esos contenidos.
    const generic = [{ title: 'Introducción a los costos' }, { title: 'Materiales y producción' }, { title: 'Informe de decisiones' }];
    eq(SVC.uncoveredUnitContents(ctx, generic), ctx.units[0].contents.map((c) => c.text), 'capítulos genéricos: nada cubierto');
    const specific = [{ title: 'La hoja de costos', description: 'Hoja de costos por órdenes de producción' }, { title: 'Costos indirectos', objective: 'Distribuir los costos indirectos de fabricación' }, { title: 'Inventarios' }];
    eq(SVC.uncoveredUnitContents(ctx, specific), ['Toma de decisiones con información de costos', 'Producción equivalente'], 'capítulos específicos: cubre lo que trabajan (descripción incluida)');
    const ch = (id, extra = {}) => ({ id, proposed: false, kind: 'content', applicationMinutes: null, ...extra });
    const dist = { counts: { evaluations: 2 }, modules: [
      { id: 'm1', examEnabled: true, chapters: [ch('c1'), ch('c2', { applicationMinutes: 60 }), ch('p1', { proposed: true, kind: 'practice', applicationMinutes: 90 })] },
      { id: 'm2', examEnabled: true, chapters: [ch('c3')] }] };
    const links = new Map([['c1', ['RA1']], ['c2', ['RA2']], ['c3', ['RA3']]]);
    const ev = (instrument, outcomeIds) => ({ ...ctx, evaluation: [{ id: 'EV', instrument, weightPct: 25, outcomeIds }] });
    eq(SVC.uncoveredEvaluations(ev('Proyecto de costeo por órdenes', ['RA3']), dist, links), [{ instrument: 'Proyecto de costeo por órdenes', outcomes: ['RA3'], kind: 'performance', chapterIds: ['c3'] }], 'proyecto de RA3 sin Actividad de Aplicación donde se trabaja RA3 (destino: el capítulo de RA3)');
    eq(SVC.uncoveredEvaluations(ev('Examen de casos clínicos', ['RA3']), dist, links), [], 'L84-3 Mn6: «Examen de casos» es una prueba (la evaluación del módulo 2 la cubre)');
    eq(SVC.uncoveredUnitContents({ units: [{ contents: [{ text: 'Clasificación de los costos' }, { text: 'Control de materiales' }] }] }, [{ title: 'Cómo clasificar los costos' }, { title: 'Controlar los materiales' }]), [], 'L84-3 Mn4: paráfrasis verbales cubren');
    eq(SVC.uncoveredEvaluations(ev('Taller práctico', ['RA1']), dist, links), [], 'la práctica del módulo (hereda RA1) lo evidencia');
    eq(SVC.uncoveredEvaluations(ev('Examen parcial', ['RA3']), dist, links), [], 'la evaluación del módulo 2 trabaja RA3');
    const noExam = { counts: { evaluations: 1 }, modules: [{ ...dist.modules[0] }, { ...dist.modules[1], examEnabled: false }] };
    eq(SVC.uncoveredEvaluations(ev('Examen parcial', ['RA3']), noExam, links).map((x) => x.kind), ['exam'], 'sin evaluación que trabaje RA3 ni final');
    const target = byId(V.verifyDesign({ ...base, uncoveredEvaluations: [{ instrument: 'Proyecto', outcomes: ['RA3'], kind: 'performance', chapterIds: ['c3'] }] })).evaluation_performance.fix;
    eq([target.kind, target.action, target.targets.chapterIds], ['editor', 'application', ['c3']], 'L84-3 Mn5: lleva a la Actividad de Aplicación del capítulo que trabaja el resultado');
    const v = byId(V.verifyDesign({ ...base, uncoveredEvaluations: [{ instrument: 'Proyecto de costeo', outcomes: ['RA3'], kind: 'performance' }, { instrument: 'Parcial', outcomes: ['RA3'], kind: 'exam' }] }));
    eq([v.evaluation_performance.severity, v.evaluation_performance.fix.action, v.evaluation_exams.fix.action], ['warning', 'outcome_links', 'module_exams'], 'advertencias con su corrección');
    eq(byId(V.verifyDesign({ ...base, preferences: { emphasis: 'balanced', applicationActivities: 'none' }, uncoveredEvaluations: [{ instrument: 'Proyecto', outcomes: [], kind: 'performance' }] })).evaluation_performance.fix.kind, 'adjust', 'sin actividades: Ajustar las enciende');
  });

  if (PURE_ONLY) console.log('\n⚠️  --pure-only: se SALTÓ la parte DB (no cuenta como probada).');
  else await dbChecks();
  console.log(`\n${passed} OK, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function cleanEnv() { return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }; }

async function dbChecks() {
  console.log('\nParte DB');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseDesignService } = loadDist('modules/course-design/course-design.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  const MB = loadDist('modules/generation-manifests/generation-manifest-builder.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-loop84-pg16-'));
  const DB = 'loop84db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, unowned: process.env.ALLOW_UNOWNED_COURSES, rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, atr: process.env.DYNAMIC_ACTIVITY_TYPE_RULES };
  let started = false;
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql',
        'supabase-migration-v21-blueprint-profiles.sql', 'supabase-migration-pedagogy-profiles.sql', 'supabase-migration-practice-chapters.sql',
        'supabase-migration-application-activities.sql', 'supabase-migration-academic-context.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_ACTIVITY_TYPE_RULES = '2';
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [CourseModule, CourseChapter], synchronize: false });
    await ds.initialize();
    const coursesStub = {
      async findOne(id, ownerId) {
        const [row] = await ds.query(`select id, title, structure_version, structure_version_counter from public.courses where id = $1 and owner_id = $2`, [id, ownerId]);
        if (!row) throw new NotFoundException(`Course #${id} not found`);
        return { id: row.id, title: row.title, structureVersion: row.structure_version, structureVersionCounter: row.structure_version_counter };
      },
    };
    const profiles = new CourseProfilesService(ds, coursesStub);
    const blueprints = new CourseBlueprintsService(ds);
    const pedagogy = new PedagogyService(ds, coursesStub);
    const design = new CourseDesignService(ds, coursesStub, pedagogy);
    const { CourseFactsService } = loadDist('modules/course-facts/course-facts.service.js');
    const facts = new CourseFactsService(ds);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const OTHER = '99999999-8888-4777-8666-555555555555';
    const counter = async (cid) => (await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c;
    const doc = (await A.extractAcademicContext([{ name: 'micro.docx', data: await F.fixture('consistent', 'docx') }])).context;
    const docCourse = async (title) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, title]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Módulo 1') returning id`, [c.id]);
      await ds.query(`insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 0, 'Nuevo capítulo')`, [c.id, m.id]);
      await profiles.append(c.id, OWNER, 'academic', doc);
      const v = (await profiles.getCurrent(c.id, OWNER, 'academic')).version;
      await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: await counter(c.id), contextVersion: v });
      return c.id;
    };
    const liveCounts = async (cid) => {
      const rows = await ds.query(`select to_jsonb(ch) ->> 'chapter_kind' k, video_enabled v, (to_jsonb(ch) ->> 'application_minutes')::int a from public.course_chapters ch where course_id = $1`, [cid]);
      return { chapters: rows.length, practiceChapters: rows.filter((r) => r.k === 'practice').length, videoChapters: rows.filter((r) => r.v).length, applicationActivities: rows.filter((r) => r.a).length };
    };

    await check('VF4 la recomendación trae la verificación del mismo diseño (alineación real)', async () => {
      const cid = await docCourse('Con documento');
      const r = await design.recommend(cid, OWNER, {});
      assert(r.verification && r.verification.verificationVersion === 1, 'verificación');
      const ids = Object.fromEntries(r.verification.checks.map((c) => [c.id, c]));
      eq(ids.hours.severity, 'ok', 'horas');
      eq(ids.outcomes.title, '6 de 6 resultados de aprendizaje con evidencia · 0 de 2 competencias', 'cobertura de resultados y competencias');
      assert(r.verification.checks.some((x) => /competencia CO1/.test(x.title) && x.fix && x.fix.kind), 'la competencia sin vincular trae su «Corregir»');
      eq(ids.contents, undefined, 'la estructura armada desde el documento cubre sus contenidos (sin falsos positivos)');
      eq(r.verification.blocking, false, 'sin bloqueo: ' + JSON.stringify(r.verification.checks.filter((x) => x.severity === 'critical' || x.severity === 'warning').map((x) => [x.id, x.title])));
    });

    await check('VF5 «Corregir» automático: solo contenido sin vínculos; docente, prácticas y desvinculados intactos; vista previa; 409 / 400 / 404', async () => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'Vínculos', 'dynamic', true, 'h5p') returning id`, [OWNER]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Costos') returning id`, [c.id]);
      const titles = ['Elementos del costo y su clasificación', 'Costo de materiales y mano de obra', 'Sistema de costeo por órdenes de producción', 'Práctica: costo de materiales y mano de obra', 'Elementos del costo en la empresa'];
      const ids = [];
      for (const [i, title] of titles.entries()) ids.push((await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective) values ($1, $2, $3, $4, $4) returning id`, [c.id, m.id, i, title]))[0].id);
      await ds.query(`update public.course_chapters set outcome_ids = '["RA6"]'::jsonb where id = $1`, [ids[2]]);
      await ds.query(`update public.course_chapters set chapter_kind = 'practice', video_enabled = false where id = $1`, [ids[3]]);
      await profiles.append(c.id, OWNER, 'academic', doc);
      // El docente desvincula A PROPÓSITO el último capítulo (vincula y luego quita todo): Cursia no lo vuelve a vincular.
      await structure.updateChapter(c.id, m.id, ids[4], OWNER, { outcomeIds: ['RA1'], expectedCounter: await counter(c.id) });
      await structure.updateChapter(c.id, m.id, ids[4], OWNER, { outcomeIds: null, expectedCounter: await counter(c.id) });
      const r = await design.recommend(c.id, OWNER, {});
      const preview = r.verification.checks.find((x) => x.id === 'outcome_links');
      assert(preview && preview.fix.kind === 'auto' && preview.fix.action === 'link_outcomes', 'vista previa con «Vincular ahora»: ' + JSON.stringify(r.verification.checks.filter((x) => x.severity !== 'ok').map((x) => x.title)));
      assert(/Elementos del costo y su clasificación/.test(preview.detail) && /Costo de materiales y mano de obra/.test(preview.detail), 'la vista previa nombra los capítulos: ' + preview.detail);
      assert(!/Práctica:|en la empresa/.test(preview.detail), 'ni la práctica ni el desvinculado entran: ' + preview.detail);
      await rejectsRe(design.fix(c.id, OWNER, 'link_outcomes', (await counter(c.id)) + 5), /STRUCTURE_CHANGED/, 'contador viejo', 409);
      await rejectsRe(design.fix(c.id, OWNER, 'borrar_todo', await counter(c.id)), /Acción desconocida/, 'acción desconocida', 400);
      await rejectsRe(design.fix(c.id, OTHER, 'link_outcomes', await counter(c.id)), /not found/, 'ajeno', 404);
      const before = await counter(c.id);
      const fx = await design.fix(c.id, OWNER, 'link_outcomes', before);
      eq([fx.linkedChapters, fx.structureVersionCounter, fx.applied.map((a) => a.chapter)], [2, before + 1, titles.slice(0, 2)], 'vinculó lo de la vista previa y subió el contador');
      const rows = Object.fromEntries((await ds.query(`select id, outcome_ids from public.course_chapters where course_id = $1`, [c.id])).map((x) => [x.id, x.outcome_ids]));
      eq(rows[ids[2]], ['RA6'], 'los vínculos del docente no se tocan');
      eq([rows[ids[3]], rows[ids[4]]], [null, null], 'la práctica y el desvinculado a propósito siguen sin vínculos');
      assert([ids[0], ids[1]].every((id) => Array.isArray(rows[id]) && rows[id].length), 'los de contenido quedaron vinculados');
      const after = await design.recommend(c.id, OWNER, {});
      assert(!after.verification.checks.some((x) => x.fix && x.fix.kind === 'auto'), 'ya no queda nada que vincular: ningún «automático» (C1): ' + JSON.stringify(after.verification.checks.filter((x) => x.fix && x.fix.kind === 'auto').map((x) => x.title)));
      const again = await design.fix(c.id, OWNER, 'link_outcomes', fx.structureVersionCounter);
      eq([again.linkedChapters, again.structureVersionCounter], [0, fx.structureVersionCounter], 'idempotente: sin cambios no sube el contador');
      // Vincular a mano borra la marca: desvincular de nuevo la vuelve a poner (la marca sigue la última decisión).
      await structure.updateChapter(c.id, m.id, ids[4], OWNER, { outcomeIds: ['RA1'], expectedCounter: await counter(c.id) });
      const pins = (await ds.query(`select metadata -> 'designPins' p from public.courses where id = $1`, [c.id]))[0].p || {};
      assert(!(pins[ids[4]] && pins[ids[4]].noLinks), 'vincular borra la marca de desvinculado');
    });

    await check('VF7 un video fijado en un capítulo de práctica no se informa como fijado', async () => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'Práctica', 'dynamic', true, 'h5p') returning id`, [OWNER]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'M') returning id`, [c.id]);
      const [ch] = await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, chapter_kind, video_enabled) values ($1, $2, 0, 'Práctica', 'practice', false) returning id`, [c.id, m.id]);
      const up = await structure.updateChapter(c.id, m.id, ch.id, OWNER, { videoEnabled: false, pinVideo: true, expectedCounter: await counter(c.id) });
      eq(up.videoPinned, undefined, 'sin videoPinned');
    });

    await check('VF9 aplicar: la profundización que propone el diseño hereda los resultados de su módulo; después no hay A4', async () => {
      const cid = await docCourse('Profundización');
      const card = await design.recommend(cid, OWNER, { adjust: { emphasis: 'depth', targetHours: 96 } });
      const proposed = card.design.modules.flatMap((m) => m.chapters.filter((c) => c.proposed && c.kind === 'content').map((c) => ({ m: m.id, title: c.title })));
      assert(proposed.length > 0, 'el diseño propone capítulos de contenido: ' + JSON.stringify(card.design.counts));
      assert(!card.verification.checks.some((c) => /no está claramente asociado/.test(c.title)), 'ni en la tarjeta (heredan en la materialización)');
      const v = (await profiles.getCurrent(cid, OWNER, 'pedagogy')).version;
      await profiles.append(cid, OWNER, 'pedagogy', card.profile, v);
      await structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: card.design.proposalSha256 });
      const rows = await ds.query(`select module_id, title, outcome_ids, to_jsonb(ch) ->> 'chapter_kind' k from public.course_chapters ch where course_id = $1`, [cid]);
      const titles = new Set(proposed.map((p) => p.title));
      for (const p of proposed) {
        const row = rows.find((r) => r.title === p.title && r.module_id === p.m);
        const union = [...new Set(rows.filter((r) => r.module_id === p.m && r.k !== 'practice' && !titles.has(r.title)).flatMap((r) => r.outcome_ids || []))].sort();
        assert(union.length > 0, `el módulo de «${p.title}» tiene resultados`);
        eq(row && row.outcome_ids, union, `«${p.title}» hereda los resultados de su módulo`);
      }
      const after = await design.recommend(cid, OWNER, {});
      assert(!after.verification.checks.some((c) => /no está claramente asociado/.test(c.title)), 'después de aplicar no aparece «sin resultado»: ' + JSON.stringify(after.verification.checks.filter((c) => c.severity !== 'ok').map((c) => c.title)));
    });

    await check('VF10 «sin vínculos» solo al quitarlos; el panel académico no sugiere prácticas ni desvinculados; «Liberar» limpia marcas de borrados', async () => {
      const { AcademicContextService } = loadDist('modules/academic-context/academic-context.service.js');
      const acx = new AcademicContextService(ds, coursesStub, null, null);
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'Marcas', 'dynamic', true, 'h5p') returning id`, [OWNER]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Costos') returning id`, [c.id]);
      const ids = [];
      for (const [i, title] of ['Elementos del costo y su clasificación', 'Costo de materiales y mano de obra', 'Práctica: costo de materiales y mano de obra', 'Sistema de costeo por órdenes de producción'].entries()) {
        ids.push((await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective) values ($1, $2, $3, $4, $4) returning id`, [c.id, m.id, i, title]))[0].id);
      }
      await ds.query(`update public.course_chapters set chapter_kind = 'practice', video_enabled = false where id = $1`, [ids[2]]);
      await profiles.append(c.id, OWNER, 'academic', doc);
      const pins = async () => (await ds.query(`select metadata -> 'designPins' p from public.courses where id = $1`, [c.id]))[0].p || {};
      await structure.updateChapter(c.id, m.id, ids[0], OWNER, { outcomeIds: null, expectedCounter: await counter(c.id) });
      eq((await pins())[ids[0]], undefined, 'null a un capítulo sin vínculos: no deja marca');
      await structure.updateChapter(c.id, m.id, ids[1], OWNER, { outcomeIds: ['RA1'], expectedCounter: await counter(c.id) });
      await structure.updateChapter(c.id, m.id, ids[1], OWNER, { outcomeIds: null, expectedCounter: await counter(c.id) });
      eq((await pins())[ids[1]], { noLinks: true }, 'quitar los vínculos deja la marca');
      const dz = await acx.design(c.id, OWNER);
      const byCh = Object.fromEntries(dz.outcomeLinks.map((s) => [s.chapterId, s]));
      eq([byCh[ids[1]].status, byCh[ids[2]].status], ['none', 'none'], 'el panel académico no sugiere vincular el desvinculado ni la práctica');
      assert(byCh[ids[0]].status === 'inferred' && byCh[ids[0]].suggested.length, 'los demás sí: ' + JSON.stringify(byCh[ids[0]]));
      await structure.deleteChapter(c.id, m.id, ids[1], OWNER, await counter(c.id));
      await design.clearPins(c.id, OWNER);
      eq((await pins())[ids[1]], undefined, '«Liberar» limpia la marca de un capítulo borrado');
    });

  } finally {
    if (ds) await ds.destroy().catch(() => {});
    for (const [k, v] of [['DYNAMIC_COURSE_STRUCTURE', saved.flag], ['DYNAMIC_V2_ALLOWED_OWNERS', saved.allow], ['ALLOW_UNOWNED_COURSES', saved.unowned], ['DYNAMIC_MANIFEST_RULES_VERSION', saved.rules], ['DYNAMIC_ACTIVITY_TYPE_RULES', saved.atr]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
