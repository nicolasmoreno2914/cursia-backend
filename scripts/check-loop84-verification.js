#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.4 · Verificación del diseño antes de generar. Contra dist/. USD 0.
//
// Parte pura:
//   VF1 diseño sano: todo ok, sin bloqueo; costo, audiovisual, práctica y evaluaciones en la lista
//   VF2 horas: por encima → advertencia con «Usar N h»; no alcanza → editor; contenidos > horas → CRÍTICO con «Diseñar para N h»
//   VF3 alineación: A1 con capítulos sin vínculos → «Corregir» automático; sin capítulos libres → editor; A3 → «Más
//       aplicación»; A7 / P2 → «Lo que entendimos»; sin resultados → advertencia; errores del Manifest → crítico
// Parte DB (Postgres 16 desechable; --pure-only la salta y lo dice):
//   VF4 la recomendación trae la verificación del MISMO diseño (alineación real del Coherence Engine)
//   VF5 «Corregir» automático: vincula solo los capítulos SIN vínculos (los del docente intactos), sube el contador,
//       la verificación queda limpia; contador viejo → 409; acción desconocida → 400; ajeno 404
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
    manifestErrors: [], alignment: { available: true, coverage: { outcomes: 6, covered: 6, partial: 0, uncovered: 0 }, findings: [] }, approach: { id: 'competencias', label: 'Competencias' }, policyKind: 'application_first', audiovisual: 'recommended', pinnedChapters: 0, cost: { min: '18', expected: '24', max: '33' }, unlinkedChapters: 0 };
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
    eq([byId(v).hours.severity, byId(v).hours.fix.value, v.blocking], ['critical', 31, true], 'contenidos > horas: bloquea');
  });
  await check('VF3 alineación → «Corregir»: automático, Ajustar, editor o «Lo que entendimos»; sin resultados; Manifest con errores', () => {
    const f = (rule, severity) => ({ id: rule + ':x', rule, severity, outcomeIds: ['RA1'], chapterIds: [], message: 'm ' + rule, suggestion: 's' });
    const al = { available: true, outcomes: [{ id: 'RA1', status: 'uncovered', domain: 'do' }, { id: 'RA2', status: 'covered', domain: 'know' }, { id: 'CO1', status: 'partial', domain: 'competency' }], findings: [f('A1', 'critical'), f('A3', 'warning'), f('A7', 'suggestion'), f('P2', 'suggestion'), f('A2', 'warning')] };
    const v = byId(V.verifyDesign({ ...base, alignment: al, unlinkedChapters: 2 }));
    eq([v['alignment:A1:x'].fix.kind, v['alignment:A1:x'].fix.action, v.outcomes.severity, v.outcomes.title], ['auto', 'link_outcomes', 'critical', '1 de 2 resultados de aprendizaje con evidencia · 0 de 1 competencias'], 'A1 con capítulos libres: automático');
    const onlyCo = byId(V.verifyDesign({ ...base, alignment: { available: true, outcomes: [{ id: 'RA1', status: 'covered', domain: 'do' }, { id: 'CO1', status: 'uncovered', domain: 'competency' }], findings: [f('A1c', 'warning')] } })).outcomes;
    eq(onlyCo.severity, 'warning', 'una competencia sin vincular es advertencia (no bloquea)');
    eq([v['alignment:A3:x'].fix.kind, v['alignment:A3:x'].fix.action, v['alignment:A3:x'].fix.value], ['adjust', 'emphasis', 'application'], 'A3: Más aplicación');
    eq([v['alignment:A7:x'].fix.kind, v['alignment:P2:x'].fix.kind, v['alignment:A7:x'].severity], ['understood', 'understood', 'info'], 'A7/P2');
    eq(v['alignment:A2:x'].fix.action, 'module_exams', 'A2: evaluación del módulo');
    eq(byId(V.verifyDesign({ ...base, alignment: al, unlinkedChapters: 0 }))['alignment:A1:x'].fix.kind, 'editor', 'sin capítulos libres: al editor');
    const none = byId(V.verifyDesign({ ...base, alignment: { available: false } })).outcomes;
    eq([none.severity, none.fix.kind], ['warning', 'understood'], 'sin resultados');
    const bad = V.verifyDesign({ ...base, manifestErrors: [{ code: 'DISTRIBUTION_MODEL_MISMATCH' }] });
    eq([byId(bad).consistency.severity, bad.blocking], ['critical', true], 'errores del Manifest bloquean');
    eq(byId(V.verifyDesign({ ...base, approach: null })).pedagogy.severity, 'warning', 'sin enfoque');
    eq(byId(V.verifyDesign({ ...base, counts: { ...base.counts, evaluations: 0 } })).evaluations.fix.action, 'module_exams', 'sin evaluaciones');
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
      eq(r.verification.blocking, false, 'sin bloqueo: ' + JSON.stringify(r.verification.checks.filter((x) => x.severity === 'critical' || x.severity === 'warning').map((x) => [x.id, x.title])));
    });

    await check('VF5 «Corregir» automático: vincula solo capítulos SIN vínculos; los del docente intactos; 409 / 400 / 404', async () => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'Vínculos', 'dynamic', true, 'h5p') returning id`, [OWNER]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Costos') returning id`, [c.id]);
      const titles = ['Elementos del costo y su clasificación', 'Costo de materiales y mano de obra', 'Sistema de costeo por órdenes de producción'];
      const ids = [];
      for (const [i, title] of titles.entries()) ids.push((await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective) values ($1, $2, $3, $4, $4) returning id`, [c.id, m.id, i, title]))[0].id);
      await ds.query(`update public.course_chapters set outcome_ids = '["RA6"]'::jsonb where id = $1`, [ids[2]]);
      await profiles.append(c.id, OWNER, 'academic', doc);
      const r = await design.recommend(c.id, OWNER, {});
      const auto = r.verification.checks.find((x) => x.fix && x.fix.kind === 'auto');
      assert(auto && auto.fix.action === 'link_outcomes', 'hay un «Corregir» automático: ' + JSON.stringify(r.verification.checks.filter((x) => x.severity !== 'ok').map((x) => x.title)));
      await rejectsRe(design.fix(c.id, OWNER, 'link_outcomes', (await counter(c.id)) + 5), /STRUCTURE_CHANGED/, 'contador viejo', 409);
      await rejectsRe(design.fix(c.id, OWNER, 'borrar_todo', await counter(c.id)), /Acción desconocida/, 'acción desconocida', 400);
      await rejectsRe(design.fix(c.id, OTHER, 'link_outcomes', await counter(c.id)), /not found/, 'ajeno', 404);
      const before = await counter(c.id);
      const fx = await design.fix(c.id, OWNER, 'link_outcomes', before);
      assert(fx.linkedChapters >= 1 && fx.structureVersionCounter === before + 1, 'vinculó y subió el contador: ' + JSON.stringify(fx));
      const rows = await ds.query(`select id, outcome_ids from public.course_chapters where course_id = $1`, [c.id]);
      eq(rows.find((x) => x.id === ids[2]).outcome_ids, ['RA6'], 'los vínculos del docente no se tocan');
      assert(rows.filter((x) => x.id !== ids[2]).every((x) => Array.isArray(x.outcome_ids) && x.outcome_ids.length), 'los demás quedaron vinculados');
      const again = await design.fix(c.id, OWNER, 'link_outcomes', fx.structureVersionCounter);
      eq([again.linkedChapters, again.structureVersionCounter], [0, fx.structureVersionCounter], 'idempotente: sin cambios no sube el contador');
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
