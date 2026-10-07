#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.3 · «Cursia recomienda»: diseño, horas, prioridad audiovisual y valores fijados. Contra dist/. USD 0.
//
// Parte pura:
//   DS1 prioridad audiovisual en el distribuidor: Menos (solo apertura) ≤ Recomendado (apertura y desarrollo) ≤ Más
//       (todos); práctica nunca; profundización agregada solo con «Más»; sin preferencia = comportamiento anterior IDÉNTICO
//   DS2 valores fijados por el docente: el video fijado se respeta con cualquier preferencia (y sin ella)
//   DS3 horas: con preferencia audiovisual el diseño llega a la meta igual (crece con aplicación / práctica / profundidad)
//   DS4 enfoque inferido de los resultados (Bloom) y del estudiante; horas propuestas = múltiplo de 8 hacia arriba
//   DS5 perfil: designPreferences.audiovisual válido se guarda tal cual; inválido → error claro
// Parte DB (Postgres 16 desechable; --pure-only la salta y lo dice):
//   DS6 recomendación con microcurrículo: horas del documento (64, sin redondear), enfoque recomendado con razones,
//       audiovisual recomendado, tarjeta = Manifest materializado (sin errores), costo con rango, 0 proveedores
//   DS7 sin meta: Cursia propone un múltiplo de 8 ≥ la estructura base; meta explícita (30 h) intacta
//   DS8 «Usar este diseño»: guardar el perfil efectivo → misma huella → aplicar → la estructura real tiene EXACTAMENTE los
//       conteos de la tarjeta → Blueprint → Manifest con los mismos videos, prácticas y Actividades de Aplicación
//   DS9 fijar el video de un capítulo (editor) → la recomendación lo respeta; «Liberar» lo devuelve a Cursia;
//       ajeno 404, legacy 400
//
// Uso: node scripts/check-loop83-design.js [--pure-only] [path/to/dist]
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
const DIST = loadDist('modules/study-time/distributor.js');
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
  await check('DS1 prioridad audiovisual: Menos ≤ Recomendado ≤ Más; práctica nunca; sin preferencia = idéntico al anterior', () => {
    const s = snapshot(false);
    const run = (av, t = 24) => DIST.distributeCourseHours({ snapshot: s, rules: null, targetHours: t, activityTypeRules: 2, preferences: av ? { audiovisual: av } : {} });
    const less = run('less'), rec = run('recommended'), more = run('more');
    eq(vids(less).map((x) => x.slice(0, 3)), ['100', '100'], 'Menos: solo la apertura');
    eq(vids(rec).map((x) => x.slice(0, 3)), ['110', '110'], 'Recomendado: apertura y desarrollo, no el cierre');
    assert(vids(more).every((x) => /^1+$/.test(x)), 'Más: todos los de contenido: ' + vids(more));
    assert(less.counts.videoChapters <= rec.counts.videoChapters && rec.counts.videoChapters <= more.counts.videoChapters, 'orden de videos');
    for (const d of [less, rec, more]) assert(d.modules.every((m) => m.chapters.every((c) => c.kind !== 'practice' || !c.videoEnabled)), 'práctica sin video');
    const deep = (d) => d.modules.flatMap((m) => m.chapters).filter((c) => c.proposed && c.kind === 'content');
    const big = (av) => DIST.distributeCourseHours({ snapshot: s, rules: null, targetHours: 120, activityTypeRules: 2, preferences: { audiovisual: av, emphasis: 'depth' } });
    assert(deep(big('recommended')).length > 0 && deep(big('recommended')).every((c) => !c.videoEnabled), 'Recomendado: profundización sin video');
    assert(deep(big('more')).every((c) => c.videoEnabled), 'Más: profundización con video');
    assert(rec.changes.some((c) => c.type === 'set_video'), 'los cambios de video se informan');
    const legacy = DIST.distributeCourseHours({ snapshot: snapshot(true), rules: null, targetHours: 40, activityTypeRules: 2 });
    const legacy2 = DIST.distributeCourseHours({ snapshot: snapshot(true), rules: null, targetHours: 40, activityTypeRules: 2, preferences: {} });
    eq(legacy2, legacy, 'sin preferencia: mismo resultado');
    eq([legacy.preferences, 'audiovisual' in legacy.preferences], [{ emphasis: 'balanced', applicationActivities: 'auto' }, false], 'preferencias de siempre');
    assert(vids(legacy).every((x) => /^1+$/.test(x)), 'sin preferencia el video es el de la estructura');
  });

  await check('DS2 valores fijados: el video fijado por el docente manda con cualquier preferencia (y sin ella)', () => {
    const s = snapshot(false);
    const opening = uuid(200), closing = uuid(202);
    const pins = { [opening]: { video: false }, [closing]: { video: true } };
    for (const av of ['less', 'recommended', 'more', undefined]) {
      const d = DIST.distributeCourseHours({ snapshot: s, rules: null, targetHours: 24, activityTypeRules: 2, preferences: av ? { audiovisual: av } : {}, pins });
      const ch = d.modules[0].chapters;
      eq([ch.find((c) => c.id === opening).videoEnabled, ch.find((c) => c.id === closing).videoEnabled], [false, true], `fijados con ${av || 'sin preferencia'}`);
      eq([ch.find((c) => c.id === opening).videoPinned, ch.find((c) => c.id === uuid(201)).videoPinned], [true, false], 'marca de fijado');
    }
  });

  await check('DS3 la meta se alcanza igual con Menos o Más video; si la estructura no da, lo dice (nunca infla video ni textos)', () => {
    const s = snapshot(false);
    for (const t of [16, 24, 30]) for (const av of ['less', 'recommended', 'more']) {
      const d = DIST.distributeCourseHours({ snapshot: s, rules: null, targetHours: t, activityTypeRules: 2, preferences: { audiovisual: av } });
      assert(['within_tolerance', 'above_tolerance'].includes(d.status), `${t} h ${av}: ${d.status} (${d.estimatedHours} h)`);
      assert(Math.abs(d.estimatedHours - t) <= Math.max(1, t * 0.05) + 0.5, `${t} h ${av}: ${d.estimatedHours} h`);
    }
    // 2 módulos × 3 capítulos no dan 64 h con topes razonables: lo informa y recomienda módulos (no alarga nada).
    const big = DIST.distributeCourseHours({ snapshot: s, rules: null, targetHours: 64, activityTypeRules: 2, preferences: { audiovisual: 'less' } });
    eq(big.status, 'cannot_reach_target', '64 h sin estructura suficiente');
    assert(big.recommendations.some((r) => /módulo/.test(r)), 'recomienda módulos: ' + big.recommendations.join(' | '));
    assert(big.modules.every((m) => m.chapters.every((c) => c.targetMinutes <= 240)), 'ningún capítulo supera 4 h');
  });

  await check('DS4 enfoque inferido de los resultados y del estudiante; horas propuestas = múltiplo de 8 hacia arriba', () => {
    const doIt = REC.inferWizardAnswers({ learner: { educationLevel: 'technical', priorKnowledge: 'none' }, outcomes: ['Calcula el costo de un producto', 'Aplica el costeo por órdenes', 'Elabora un informe de costos', 'Identifica los elementos del costo'], competencies: [] });
    eq([doIt.answers.q3, doIt.answers.q1.educationLevel, doIt.doShare], [['practice', 'real_application'], 'technical', 0.75], 'saber hacer');
    const know = REC.inferWizardAnswers({ learner: null, outcomes: ['Explica la historia de la contabilidad', 'Describe los tipos de costos', 'Comprende el ciclo contable'], competencies: [] });
    eq(know.answers.q3, ['concepts'], 'saber');
    eq(REC.inferWizardAnswers({ learner: null, outcomes: [], competencies: [] }).doShare, null, 'sin resultados no se infiere nada');
    const s1 = REC.recommendApproachFromFacts({ learner: { educationLevel: 'technical' }, outcomes: doIt.answers.q2.do.concat(doIt.answers.q2.know), competencies: [] });
    assert(s1 && s1.approach && s1.reasons.length && /resultados piden hacer/.test(s1.reasons[0]), 'enfoque con razón: ' + JSON.stringify(s1));
    eq(REC.recommendApproachFromFacts({ learner: null, outcomes: [], competencies: [] }), null, 'sin resultados no hay recomendación');
    eq([REC.proposeTargetHours(30.4).value, REC.proposeTargetHours(32).value, REC.proposeTargetHours(32.2).value, REC.proposeTargetHours(3).value, REC.proposeTargetHours(0).value], [32, 32, 40, 8, 8], 'múltiplo de 8 hacia arriba');
  });

  await check('DS5 perfil: audiovisual válido se guarda tal cual (también «recommended»); inválido → error', () => {
    const p = { ...PP.emptyPedagogicalProfile(), designPreferences: { audiovisual: 'recommended' } };
    eq(PP.normalizePedagogicalProfile(p).designPreferences, { audiovisual: 'recommended' }, 'se conserva');
    eq(PP.profileDesignPreferences(p), { audiovisual: 'recommended' }, 'preferencias');
    const bad = { ...PP.emptyPedagogicalProfile(), designPreferences: { audiovisual: 'mucho' } };
    assert(PP.validatePedagogicalProfile(bad).some((e) => e.path === 'designPreferences.audiovisual'), 'inválido');
    eq(PP.normalizePedagogicalProfile(PP.emptyPedagogicalProfile()).designPreferences, undefined, 'sin preferencias: perfil de siempre');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-loop83-pg16-'));
  const DB = 'loop83db';
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

    await check('DS6 con microcurrículo: 64 h del documento (sin redondear), enfoque recomendado, audiovisual recomendado, tarjeta = Manifest, costo con rango', async () => {
      const cid = await docCourse('Con documento');
      const r = await design.recommend(cid, OWNER, {});
      eq([r.hours.target, r.hours.source], [64, 'document'], 'horas del documento');
      assert(r.approach && r.approach.source === 'recommended' && r.approach.reasons.length > 0, 'enfoque recomendado con razones: ' + JSON.stringify(r.approach));
      eq(r.preferences.audiovisual, 'recommended', 'audiovisual por defecto');
      eq([r.design.manifestErrors, r.design.applicable, r.providersCalled], [[], true, 0], 'tarjeta = Manifest materializado');
      assert(['within_tolerance', 'above_tolerance'].includes(r.design.status) && Math.abs(r.design.estimatedHours - 64) <= 3.5, 'llega a las horas: ' + r.design.estimatedHours);
      assert(r.cost && Number(r.cost.min) <= Number(r.cost.expected) && Number(r.cost.expected) <= Number(r.cost.max) && Number(r.cost.expected) > 0, 'costo con rango: ' + JSON.stringify(r.cost));
      assert(r.design.counts.practiceChapters >= 0 && r.design.counts.applicationActivities > 0, 'aplicación para llegar a 64 h');
      assert(r.profileChanged === true, 'el perfil efectivo difiere del guardado (enfoque y audiovisual nuevos)');
      assert(r.design.modules.some((m) => m.chapters.some((c) => c.outcomeIds.length)), 'capítulos con sus resultados (vista por resultado)');
    });

    await check('DS7 sin meta: Cursia propone un múltiplo de 8 ≥ la estructura base; una meta explícita (30 h) queda intacta', async () => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'Sin meta', 'dynamic', true, 'h5p') returning id`, [OWNER]);
      for (let mi = 0; mi < 2; mi++) {
        const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, $2, $3) returning id`, [c.id, mi, `Módulo ${mi + 1}`]);
        for (let ci = 0; ci < 3; ci++) await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled) values ($1, $2, $3, $4, 'Aplicar en un caso real', false, true)`, [c.id, m.id, ci, `Tema ${mi + 1}.${ci + 1}`]);
      }
      await profiles.append(c.id, OWNER, 'academic', A.buildProposedContext(null, { outcomes: ['Calcula indicadores de gestión', 'Elabora un tablero de control', 'Explica los tipos de indicadores'] }));
      const r = await design.recommend(c.id, OWNER, {});
      eq(r.hours.source, 'proposed', 'propuestas por Cursia');
      assert(r.hours.target % 8 === 0 && r.hours.target >= r.hours.proposedFrom, `múltiplo de 8 ≥ base: ${r.hours.target} / ${r.hours.proposedFrom}`);
      assert(/Cursia propone/.test(r.hours.reason), 'con su razón');
      const adj = await design.recommend(c.id, OWNER, { adjust: { targetHours: 30 } });
      eq([adj.hours.target, adj.hours.source], [30, 'adjusted'], 'meta explícita sin redondear');
      await rejectsRe(design.recommend(c.id, OWNER, { adjust: { targetHours: 0.3 } }), /auto/, 'horas inválidas', 400);
      await rejectsRe(design.recommend(c.id, OWNER, { adjust: { approach: 'inventado' } }), /Enfoque desconocido/, 'enfoque inválido', 400);
    });

    await check('DS8 «Usar este diseño»: mismo perfil → misma huella → aplicar → estructura real = tarjeta → Blueprint → Manifest = tarjeta', async () => {
      const cid = await docCourse('Usar este diseño');
      const card = await design.recommend(cid, OWNER, { adjust: { audiovisual: 'less' } });
      const v = (await profiles.getCurrent(cid, OWNER, 'pedagogy')).version;
      await profiles.append(cid, OWNER, 'pedagogy', card.profile, v);
      const again = await design.recommend(cid, OWNER, {});
      eq([again.profileChanged, again.design.proposalSha256], [false, card.design.proposalSha256], 'guardado: la misma huella que la tarjeta');
      const ap = await structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: card.design.proposalSha256 });
      eq(ap.estimatedHours, card.design.estimatedHours, 'horas aplicadas = tarjeta');
      const live = await liveCounts(cid);
      const c = card.design.counts;
      eq(live, { chapters: c.chapters, practiceChapters: c.practiceChapters, videoChapters: c.videoChapters, applicationActivities: c.applicationActivities }, 'estructura real = tarjeta');
      const lock = await blueprints.lock(cid, OWNER, await counter(cid));
      const read = await blueprints.getByNumberAnySchema(cid, OWNER, lock.blueprint.blueprintNumber);
      const m = MB.buildGenerationManifestV3(read.snapshot, { courseId: cid, blueprintId: read.id, blueprintNumber: read.blueprintNumber, blueprintSha256: read.sha256 }, { activityTypeRules: 2 });
      eq(MB.validateGenerationManifestV3(m, read.snapshot, m.source), [], 'Manifest válido');
      const t = m.totals;
      eq([t.videoCount, t.applicationActivityCount], [c.videoChapters, c.applicationActivities], 'Manifest = tarjeta (videos y Actividades de Aplicación)');
      const after = await design.recommend(cid, OWNER, {});
      eq([after.design.status, after.design.counts.videoChapters], ['within_tolerance', c.videoChapters], 'estable sobre su propio resultado');
    });

    await check('DS9 video fijado en el editor → la recomendación lo respeta; «Liberar» lo devuelve a Cursia; ajeno 404, legacy 400', async () => {
      const cid = await docCourse('Fijados');
      const r0 = await design.recommend(cid, OWNER, {});
      const opening = r0.design.modules[0].chapters.find((c) => c.kind === 'content' && c.videoEnabled);
      assert(opening, 'hay una apertura con video');
      const [mod] = await ds.query(`select module_id from public.course_chapters where id = $1`, [opening.id]);
      const up = await structure.updateChapter(cid, mod.module_id, opening.id, OWNER, { videoEnabled: false, pinVideo: true, expectedCounter: await counter(cid) });
      eq(up.videoPinned, true, 'fijado');
      const r1 = await design.recommend(cid, OWNER, { adjust: { audiovisual: 'more' } });
      const ch = r1.design.modules[0].chapters.find((c) => c.id === opening.id);
      eq([ch.videoEnabled, ch.videoPinned, r1.pinnedChapters], [false, true, 1], 'Más video respeta lo fijado');
      await structure.updateChapter(cid, mod.module_id, opening.id, OWNER, { title: 'Otro título', expectedCounter: await counter(cid) });
      eq((await design.recommend(cid, OWNER, {})).pinnedChapters, 1, 'editar otra cosa no libera');
      eq((await design.clearPins(cid, OWNER)).released, 1, 'Liberar');
      const r2 = await design.recommend(cid, OWNER, { adjust: { audiovisual: 'more' } });
      eq([r2.pinnedChapters, r2.design.modules[0].chapters.find((c) => c.id === opening.id).videoEnabled], [0, true], 'vuelve a decidir Cursia');
      await ds.query(`update public.courses set metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{designPins}', '{"not-a-uuid":{"video":true}}'::jsonb) where id = $1`, [cid]);
      eq((await design.recommend(cid, OWNER, {})).pinnedChapters, 0, 'un valor fijado inválido se ignora');
      await rejectsRe(design.recommend(cid, OTHER, {}), /not found/, 'ajeno', 404);
      const [legacy] = await ds.query(`insert into public.courses (owner_id, title) values ($1, 'Legacy') returning id`, [OWNER]);
      await rejectsRe(design.recommend(legacy.id, OWNER, {}), /solo admite cursos "dynamic"/, 'legacy', 400);
    });
    await check('DS10 (review L83 I-4) perfil sin horas + documento con 64 h → la recomendación usa 64 h del documento (no propone otra)', async () => {
      const cid = await docCourse('Sin horas en el perfil');
      const p = (await profiles.getCurrent(cid, OWNER, 'pedagogy')).profile;
      const noHours = JSON.parse(JSON.stringify(p)); delete noHours.targetHours; delete noHours.designRules;
      await profiles.append(cid, OWNER, 'pedagogy', noHours, (await profiles.getCurrent(cid, OWNER, 'pedagogy')).version);
      const r = await design.recommend(cid, OWNER, {});
      eq([r.hours.target, r.hours.source], [64, 'document'], 'las del documento');
    });

    await check('DS11 (review L83 I-3) horas propuestas → «Usar» las registra como propuestas: «Lo que sabemos» = inferidas y un microcurrículo posterior las reemplaza', async () => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'Propuestas', 'dynamic', true, 'h5p') returning id`, [OWNER]);
      for (let mi = 0; mi < 2; mi++) {
        const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, $2, $3) returning id`, [c.id, mi, `Módulo ${mi + 1}`]);
        for (let ci = 0; ci < 2; ci++) await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective) values ($1, $2, $3, $4, 'Aplicar en un caso')`, [c.id, m.id, ci, `Tema ${mi + 1}.${ci + 1}`]);
      }
      await profiles.append(c.id, OWNER, 'academic', A.buildProposedContext(null, { outcomes: ['Calcula indicadores', 'Elabora un tablero'] }));
      const card = await design.recommend(c.id, OWNER, {});
      eq(card.hours.source, 'proposed', 'propuestas');
      await rejectsRe(design.recordHoursOrigin(c.id, OWNER, card.hours.target), /HOURS_NOT_SAVED/, 'sin guardar el perfil no se registra', 400);
      await profiles.append(c.id, OWNER, 'pedagogy', card.profile, (await profiles.getCurrent(c.id, OWNER, 'pedagogy')).version);
      await design.recordHoursOrigin(c.id, OWNER, card.hours.target);
      const again = await design.recommend(c.id, OWNER, {});
      eq([again.hours.source, again.hours.target, /Cursia propuso/.test(again.hours.reason || '')], ['proposed', card.hours.target, true], 'siguen siendo propuestas');
      const f = await facts.getFacts(c.id, OWNER);
      eq([f.targetHours.value, f.targetHours.source, f.conflicts.length], [card.hours.target, 'inferred', 0], 'Lo que sabemos: inferidas');
      const r = await profiles.append(c.id, OWNER, 'academic', doc, (await profiles.getCurrent(c.id, OWNER, 'academic')).version);
      eq(r.derivedPedagogy.applied, true, 'derivado');
      const f2 = await facts.getFacts(c.id, OWNER);
      eq([f2.targetHours.value, f2.targetHours.source, f2.conflicts.filter((x) => x.field === 'pedagogy.targetHours').length], [64, 'document', 0], 'el documento reemplaza las propuestas sin conflicto');
      const legit = await design.recommend(c.id, OWNER, { adjust: { targetHours: 40 } });
      await profiles.append(c.id, OWNER, 'pedagogy', legit.profile, (await profiles.getCurrent(c.id, OWNER, 'pedagogy')).version);
      eq((await facts.getFacts(c.id, OWNER)).targetHours.source, 'profile', 'las que elige el docente son suyas');
    });

    await check('DS12 video fijado entre la tarjeta y «Aplicar» → 409 visible; un cambio manual SIN fijar libera el valor fijado; fijados de capítulos borrados no cuentan', async () => {
      const cid = await docCourse('Carrera de fijados');
      const card = await design.recommend(cid, OWNER, {});
      const v = (await profiles.getCurrent(cid, OWNER, 'pedagogy')).version;
      await profiles.append(cid, OWNER, 'pedagogy', card.profile, v);
      const ch = card.design.modules[0].chapters.find((x) => x.kind === 'content' && x.videoEnabled && !x.proposed);
      const [mod] = await ds.query(`select module_id from public.course_chapters where id = $1`, [ch.id]);
      await structure.updateChapter(cid, mod.module_id, ch.id, OWNER, { videoEnabled: false, pinVideo: true, expectedCounter: await counter(cid) });
      await rejectsRe(structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: card.design.proposalSha256 }), /PROPOSAL_CHANGED/, 'la tarjeta vieja no se aplica', 409);
      await structure.updateChapter(cid, mod.module_id, ch.id, OWNER, { videoEnabled: true, expectedCounter: await counter(cid) });
      eq((await design.recommend(cid, OWNER, {})).pinnedChapters, 0, 'el cambio sin fijar libera');
      await structure.updateChapter(cid, mod.module_id, ch.id, OWNER, { videoEnabled: false, pinVideo: true, expectedCounter: await counter(cid) });
      await ds.query(`update public.courses set metadata = jsonb_set(metadata, '{designPins}', (metadata -> 'designPins') || '{"00000000-0000-4000-8000-000000000999":{"video":true}}'::jsonb) where id = $1`, [cid]);
      eq((await design.recommend(cid, OWNER, {})).pinnedChapters, 1, 'solo los fijados de capítulos que existen');
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
