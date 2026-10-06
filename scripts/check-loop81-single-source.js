#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.1 · Una sola fuente de verdad + cargador único. Contra el código COMPILADO en dist/ ("npm run build" antes).
// USD 0: sin red, sin proveedores (la lectura avanzada usa un transcriptor FALSO).
//
// Parte pura:
//   SS1 pedido del curso: normalización, parseo estricto, chips de Datos → vocabulario del motor
//   SS2 «Lo que sabemos del curso»: autoridad documento > perfil > usuario, orígenes y conflictos
//   SS3 contexto congelado: alineado con el estudiante que congeló el Blueprint; sin él queda IDÉNTICO; ida y vuelta
//       de los textos sin pérdida (idempotente)
//   SS4 dueño POR CAMPO (review L81 I1/I2): vacío / del documento / del usuario; horas antes del documento; el nivel que
//       decidió el docente manda sobre el documento; «Usar los datos del documento» (force)
//   SS5 calidad de la extracción (escaneo, sin lo esencial) y costo estimado de la lectura avanzada (rango, sin red)
// Parte DB (Postgres 16 local desechable; se salta SOLO con --pure-only, y lo dice):
//   SS6 pedido del curso: PUT/GET, idempotente, otro dueño 404, legacy 400
//   SS7 guardar el contexto deriva el perfil pedagógico SOLO (sin «Usar en el perfil»): 64 h, resultados, nivel
//   SS8 el docente cambia a mano el estudiante → un contexto nuevo NO lo pisa y «Lo que sabemos» informa el conflicto
//   SS9 guardar el enfoque sin tocar lo del documento lo deja «intacto»: el contexto nuevo sí se deriva
//   SS11 horas antes del documento: el documento llena estudiante y resultados y RESPETA las horas (conflicto visible);
//        «Usar los datos del documento» las reemplaza por decisión explícita
//   SS12 perfil anterior a 8.1 igual al documento («Usar en el perfil»): cuenta como del documento y sigue actualizándose
//   SS13 estudiante congelado en el Blueprint (con Actividades de Aplicación) → alinea el contexto del run
//   SS10 lectura avanzada: estimar sin proveedor; apagada → 409; sin aceptar el costo → 409; aceptada → transcripción
//        falsa + MISMO extractor → contexto con resultados; gasto registrado (también si la lectura sale truncada)
//
// Uso: node scripts/check-loop81-single-source.js [--pure-only] [path/to/dist]
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
  const abs = path.join(distRoot, rel);
  try { return require(abs); } catch (err) { console.error(`❌ No se pudo cargar ${abs} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); }
}
const CF = loadDist('modules/course-facts/course-facts.js');
const Q = loadDist('modules/academic-context/extraction-quality.js');
const ADV = loadDist('modules/academic-context/advanced-extraction.js');
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

const BRIEF = { nombre: 'Contabilidad de Costos', obj: 'Calcular y controlar los costos de producción de una empresa', sector: 'Contabilidad', pais: 'Colombia',
  contexto: 'Técnico / Tecnólogo — formación vocacional y técnica, orientada a competencias prácticas e inserción laboral rápida',
  nivel: 'Básico — sin conocimientos previos', tono: 'Directo y práctico, enfocado en qué hacer y cómo' };

(async () => {
  console.log('Parte pura');
  const ctx = (await A.extractAcademicContext([{ name: 'micro.docx', data: await F.fixture('consistent', 'docx') }])).context;
  const emptyPed = () => ({ pedagogyProfileVersion: 1, primaryApproach: null, secondaryApproaches: [], learner: { description: null, ageGroup: null, educationLevel: null, priorKnowledge: null, experience: null }, learningOutcomes: { know: [], do: [], competencies: [] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual' });

  await check('SS1 pedido del curso: normalización, parseo estricto y chips → vocabulario', () => {
    eq(CF.normalizeBriefFields({ obj: '  dos   espacios ', sector: '', otro: 'x', pais: 7 }), { obj: 'dos espacios' }, 'normaliza y descarta');
    eq(CF.parseBrief({ briefVersion: 1, fields: { obj: ' a ' }, updatedAt: 't' }), { briefVersion: 1, fields: { obj: 'a' }, updatedAt: 't' }, 'válido');
    for (const bad of [null, [], { briefVersion: 2, fields: {} }, { briefVersion: 1 }]) eq(CF.parseBrief(bad), null, `inválido ${JSON.stringify(bad)}`);
    eq(['Bachillerato — x', 'Técnico / Tecnólogo — x', 'Universitario — x', 'Posgrado — x', 'Corporativo — x', 'Otra cosa', ''].map(CF.educationLevelFromBrief),
      ['secondary', 'technical', 'university', 'university', 'professional', null, null], 'nivel educativo');
    eq(['Básico — sin conocimientos previos', 'Intermedio — conoce', 'Avanzado — ya trabaja', 'x'].map(CF.priorKnowledgeFromBrief), ['none', 'intermediate', 'advanced', null], 'previos');
  });

  const brief = { briefVersion: 1, fields: CF.normalizeBriefFields(BRIEF), updatedAt: 't' };
  await check('SS2 «Lo que sabemos»: autoridad, orígenes y conflictos', () => {
    const solo = CF.resolveCourseFacts({ courseTitle: 'Curso sin título', institutionId: null, brief, academic: null, pedagogy: null, derivation: null, suggested: null });
    eq([solo.title.value, solo.title.source, solo.topic.source, solo.educationLevel.value, solo.educationLevel.source, solo.priorKnowledge.value, solo.targetHours.value, solo.conflicts], ['Contabilidad de Costos', 'user', 'user', 'technical', 'user', 'none', null, []], 'solo el pedido');
    const ped = { ...emptyPed(), targetHours: 48 };
    const suggested = A.suggestProfileFromContext(ctx, null).profile;
    const withDoc = CF.resolveCourseFacts({ courseTitle: 'x', institutionId: 'inst-1', brief: { ...brief, fields: { ...brief.fields, contexto: 'Universitario — x' } }, academic: { version: 1, context: ctx }, pedagogy: { version: 1, profile: ped }, derivation: null, suggested });
    eq(withDoc.educationLevel.source, 'document', 'el nivel del documento manda');
    eq(withDoc.outcomes.source, 'document', 'resultados del documento');
    eq([withDoc.targetHours.value, withDoc.targetHours.source], [48, 'profile'], 'horas: dueño = perfil');
    // El perfil trae horas puestas a mano y no hay registro de derivación (perfil anterior a 8.1): se respeta y se informa.
    eq(withDoc.conflicts.map((c) => c.field).sort(), ['educationLevel', 'pedagogy.targetHours'], 'conflictos: nivel (Datos vs documento) y horas (elegidas vs documento)');
    eq(withDoc.pedagogy.owners.targetHours, 'user', 'las horas que eligió el docente son suyas');
    eq([withDoc.document.present, withDoc.document.contextVersion, withDoc.institutionId], [true, 1, 'inst-1'], 'documento e institución');
  });

  await check('SS3 contexto congelado: alineado con el estudiante del Blueprint; sin él, idéntico; ida y vuelta sin pérdida', () => {
    const run = { nombre: 'C', sector: 'S', pais: 'Colombia', contexto: BRIEF.contexto, nivel: BRIEF.nivel, tono: 'x', obj: 'o' };
    const none = CF.alignCourseContextWithSnapshot(run, null);
    assert(none.context === run && none.changed.length === 0, 'sin estudiante congelado: el mismo objeto (mismo hash)');
    const same = CF.alignCourseContextWithSnapshot(run, { educationLevel: 'technical', priorKnowledge: 'none' });
    assert(same.context === run && same.changed.length === 0, 'mismo estudiante que Datos: sin cambios');
    const al = CF.alignCourseContextWithSnapshot(run, { educationLevel: 'university', priorKnowledge: 'basic' });
    eq(al.changed, ['contexto', 'nivel'], 'nivel y previos del Blueprint');
    assert(/^Universitario/.test(al.context.contexto) && /^Básico — conoce/.test(al.context.nivel), 'textos del vocabulario');
    const again = CF.alignCourseContextWithSnapshot(al.context, { educationLevel: 'university', priorKnowledge: 'basic' });
    assert(again.context === al.context && again.changed.length === 0, 'idempotente: ida y vuelta sin pérdida (review L81 M5)');
    for (const lvl of ['basic', 'secondary', 'technical', 'university', 'professional']) eq(CF.contextLevelOf(CF.alignCourseContextWithSnapshot({ contexto: '' }, { educationLevel: lvl }).context.contexto), lvl, `ida y vuelta ${lvl}`);
    for (const pk of ['none', 'basic', 'intermediate', 'advanced']) eq(CF.contextPriorOf(CF.alignCourseContextWithSnapshot({ nivel: '' }, { priorKnowledge: pk }).context.nivel), pk, `ida y vuelta ${pk}`);
    eq(run.nivel, BRIEF.nivel, 'no muta el original');
  });

  await check('SS4 dueño por campo: vacío / documento / usuario; horas antes del documento; nivel del docente manda; force', () => {
    const sugg = A.suggestProfileFromContext(ctx, null).profile;
    const all = (o) => CF.DERIVED_FIELDS.map((f) => o[f]);
    eq(all(CF.pedagogyFieldOwners(null, null, sugg)), CF.DERIVED_FIELDS.map(() => 'empty'), 'sin perfil: todo vacío');
    const hoursFirst = { ...emptyPed(), targetHours: 40 };
    const o1 = CF.pedagogyFieldOwners(hoursFirst, null, sugg);
    eq([o1.targetHours, o1.know, o1.description], ['user', 'empty', 'empty'], 'horas del docente; el resto vacío');
    const m1 = CF.mergeDerivedProfile(hoursFirst, sugg, o1, 1);
    eq([m1.profile.targetHours, m1.profile.learningOutcomes.do.length > 0, m1.kept, m1.changed.includes('targetHours')], [40, true, ['targetHours'], false], 'llena lo vacío y respeta las horas');
    const o2 = CF.pedagogyFieldOwners(m1.profile, m1.record, sugg);
    eq([o2.targetHours, o2.do, o2.description], ['user', 'document', 'document'], 'después: lo derivado es del documento');
    const edited = JSON.parse(JSON.stringify(m1.profile)); edited.learner.educationLevel = 'professional';
    const o3 = CF.pedagogyFieldOwners(edited, m1.record, sugg);
    eq(o3.educationLevel, 'user', 'nivel cambiado a mano');
    const facts = CF.resolveCourseFacts({ courseTitle: 'x', institutionId: null, brief, academic: { version: 1, context: ctx }, pedagogy: { version: 2, profile: edited }, derivation: m1.record, suggested: sugg });
    eq([facts.educationLevel.value, facts.educationLevel.source], ['professional', 'profile'], 'review L81 I2: la decisión del docente manda sobre el documento');
    assert(facts.conflicts.some((c) => c.field === 'pedagogy.educationLevel'), 'conflicto visible');
    eq(CF.pedagogyFieldOwners(sugg, null, sugg).do, 'document', 'igual al documento sin registro (perfil anterior a 8.1): del documento');
    const forced = CF.mergeDerivedProfile(hoursFirst, sugg, o1, 1, ['targetHours']);
    eq([forced.profile.targetHours, forced.changed.includes('targetHours')], [64, true], '«Usar los datos del documento» (force)');
  });

  await check('SS5 calidad de la extracción y costo estimado de la lectura avanzada', () => {
    const doc = (o) => ({ id: 'D1', name: 'a.pdf', mediaType: 'application/pdf', sha256: 'x', bytes: 1, pages: 4, characters: 100, extractor: { id: 'x', version: 1 }, ...o });
    const empty = { ...ctx, documents: [doc({})], outcomes: [], units: [] };
    const q1 = Q.extractionQuality(empty);
    eq([q1.sufficient, q1.issues.map((i) => i.code), q1.advancedMayHelp], [false, ['SCANNED', 'MISSING_ESSENTIALS'], true], 'escaneo sin lo esencial');
    const q2 = Q.extractionQuality(ctx);
    eq([q2.sufficient, q2.issues.length, q2.advancedMayHelp], [true, 0, false], 'el microcurrículo de prueba alcanza');
    const word = Q.extractionQuality({ ...empty, documents: [doc({ mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })] });
    eq([word.issues.map((i) => i.code), word.advancedMayHelp], [['MISSING_ESSENTIALS'], false], 'Word sin lo esencial: la lectura avanzada no ayuda');
    const e10 = ADV.estimateAdvancedExtraction(10, 'm');
    assert(e10.estimateUsd.min < e10.estimateUsd.expected && e10.estimateUsd.expected < e10.estimateUsd.max, 'rango ordenado');
    eq([e10.pages, e10.model, e10.assumptions.length], [10, 'm', 2], 'forma');
    assert(e10.estimateUsd.expected > 0.1 && e10.estimateUsd.expected < 1, `10 páginas: centavos (${e10.estimateUsd.expected})`);
    eq(ADV.estimateAdvancedExtraction(0).pages, 1, 'mínimo 1 página');
    // Review L81 I4: solo las páginas cuya transcripción cabe en una respuesta; el estimado nunca cuenta salida imposible.
    eq(ADV.ADVANCED_MAX_PAGES, 20, 'tope de páginas');
    assert(ADV.ADVANCED_MAX_PAGES * ADV.ADVANCED_TOKENS.outputPerPage <= ADV.ADVANCED_MAX_OUTPUT_TOKENS - 1000, 'cabe con margen');
    const e40 = ADV.estimateAdvancedExtraction(40);
    const outCap = ADV.ADVANCED_MAX_OUTPUT_TOKENS * ADV.ADVANCED_REFERENCE_PRICE.outputPerMTok / 1e6;
    assert(e40.estimateUsd.max <= (ADV.ADVANCED_TOKENS.inputBase + 40 * ADV.ADVANCED_TOKENS.inputPerPage) * 2 * 3 / 1e6 + outCap + 0.01, 'el máximo no supera lo que la respuesta puede producir');
  });

  if (PURE_ONLY) console.log('\n⚠️  --pure-only: se SALTÓ la parte DB (no cuenta como probada).');
  else await dbChecks(ctx);
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

async function dbChecks(ctx) {
  console.log('\nParte DB');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, BadRequestException, Logger } = require('@nestjs/common');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseFactsService } = loadDist('modules/course-facts/course-facts.service.js');
  const { AcademicContextService } = loadDist('modules/academic-context/academic-context.service.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-loop81-pg16-'));
  const DB = 'loop81db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, unowned: process.env.ALLOW_UNOWNED_COURSES, adv: process.env.ACADEMIC_ADVANCED_EXTRACTION_ENABLED, rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, atr: process.env.DYNAMIC_ACTIVITY_TYPE_RULES };
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
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3'; // Blueprint v2 (con estudiante congelado) como en staging
    process.env.DYNAMIC_ACTIVITY_TYPE_RULES = '2';
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const coursesStub = {
      async findOne(id, ownerId) {
        const [row] = await ds.query(`select id, title, structure_version, structure_version_counter from public.courses where id = $1 and owner_id = $2`, [id, ownerId]);
        if (!row) throw new NotFoundException(`Course #${id} not found`);
        return { id: row.id, title: row.title, structureVersion: row.structure_version, structureVersionCounter: row.structure_version_counter };
      },
    };
    const profiles = new CourseProfilesService(ds, coursesStub);
    const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
    const blueprints = new CourseBlueprintsService(ds);
    const FDB = loadDist('modules/course-facts/course-facts-db.js');
    const emptyPedFor = () => ({ pedagogyProfileVersion: 1, primaryApproach: null, secondaryApproaches: [], learner: { description: null, ageGroup: null, educationLevel: null, priorKnowledge: null, experience: null }, learningOutcomes: { know: [], do: [], competencies: [] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual' });
    const facts = new CourseFactsService(ds);
    const charges = [];
    const ledger = { recordCharge: async (x) => { charges.push(x); return { inserted: true, event: {} }; } };
    let transcribeCalls = 0;
    let fakeText = String(F.toText('consistent', { markdown: true }));
    let fakeTruncated = false;
    const transcriber = { transcribe: async (input) => { transcribeCalls++; return { text: fakeText, model: input.model, messageId: `msg_fake_${transcribeCalls}`, usage: { input_tokens: 9000, output_tokens: 3000 }, truncated: fakeTruncated }; } };
    const acx = new AcademicContextService(ds, coursesStub, ledger, transcriber);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const OTHER = '99999999-8888-4777-8666-555555555555';
    const newCourse = async (t) => (await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, t]))[0].id;
    const ped = async (cid) => (await profiles.getCurrent(cid, OWNER, 'pedagogy'));

    await check('SS6 pedido del curso: PUT/GET, idempotente, otro dueño 404, legacy 400', async () => {
      const cid = await newCourse('Con pedido');
      eq((await facts.getBrief(cid, OWNER)).brief, null, 'sin pedido');
      const p1 = await facts.putBrief(cid, OWNER, BRIEF);
      eq([p1.changed, p1.brief.fields.obj], [true, BRIEF.obj], 'guardado');
      eq((await facts.putBrief(cid, OWNER, { ...BRIEF, obj: `  ${BRIEF.obj}  ` })).changed, false, 'mismo pedido: sin escritura');
      eq((await facts.getBrief(cid, OWNER)).brief.fields.sector, 'Contabilidad', 'GET');
      await rejectsRe(facts.putBrief(cid, OWNER, { ...BRIEF, sector: 'X', expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }), /BRIEF_CHANGED/, 'pestaña vieja (review L81 M1)', 409);
      const up = await facts.putBrief(cid, OWNER, { ...BRIEF, sector: 'Finanzas', expectedUpdatedAt: p1.brief.updatedAt });
      eq([up.changed, up.brief.fields.sector], [true, 'Finanzas'], 'con el updatedAt vigente se guarda');
      await facts.putBrief(cid, OWNER, BRIEF);
      const [m] = await ds.query(`select metadata from public.courses where id = $1`, [cid]);
      eq(Object.keys(m.metadata), ['brief'], 'solo la clave brief');
      await rejectsRe(facts.putBrief(cid, OTHER, BRIEF), /not found/, 'otro dueño', 404);
      const [legacy] = await ds.query(`insert into public.courses (owner_id, title) values ($1, 'Legacy') returning id`, [OWNER]);
      await rejectsRe(facts.putBrief(legacy.id, OWNER, BRIEF), /solo admite cursos "dynamic"/, 'legacy', 400);
      const f = await facts.getFacts(cid, OWNER);
      eq([f.topic.source, f.educationLevel.value, f.document.present], ['user', 'technical', false], 'Lo que sabemos: desde el pedido');
    });

    await check('SS7 guardar el contexto deriva el perfil SOLO: horas, resultados y nivel del documento', async () => {
      const cid = await newCourse('Deriva');
      const r = await profiles.append(cid, OWNER, 'academic', ctx);
      eq([r.created, r.derivedPedagogy && r.derivedPedagogy.applied, r.derivedPedagogy && r.derivedPedagogy.version], [true, true, 1], 'perfil v1 derivado en la misma transacción');
      const p = await ped(cid);
      eq([p.version, p.profile.targetHours, p.profile.learningOutcomes.do.length > 0], [1, 64, true], '64 h y resultados del documento');
      eq([p.derivedFromAcademic.academicVersion, p.derivedFromAcademic.untouched, p.derivedFromAcademic.owners.do], [1, true, 'document'], 'GET pedagogy informa la derivación por campo');
      const f = await facts.getFacts(cid, OWNER);
      eq([f.outcomes.source, f.targetHours.value, f.pedagogy.derivedFromDocument, f.conflicts], ['document', 64, true, []], 'Lo que sabemos: documento, sin conflictos');
      const again = await profiles.append(cid, OWNER, 'academic', ctx);
      eq([again.created, (await ped(cid)).version], [false, 1], 're-guardar el mismo contexto no crea versiones');
    });

    await check('SS8 el docente cambia a mano el estudiante → el contexto nuevo NO lo pisa pero SÍ actualiza lo demás; conflicto visible', async () => {
      const cid = await newCourse('Editado');
      await profiles.append(cid, OWNER, 'academic', ctx);
      const p1 = (await ped(cid)).profile;
      await profiles.append(cid, OWNER, 'pedagogy', { ...p1, learner: { ...p1.learner, description: 'Trabajadores del área contable de una pyme' } });
      const ctx2 = JSON.parse(JSON.stringify(ctx));
      ctx2.hours.total = { ...ctx2.hours.total, value: 48 };
      const r = await profiles.append(cid, OWNER, 'academic', ctx2);
      eq([r.created, r.derivedPedagogy.applied, r.derivedPedagogy.changes, r.derivedPedagogy.kept], [true, true, ['targetHours'], ['description']], 'horas del documento actualizadas; el estudiante del docente, respetado');
      const p = await ped(cid);
      eq([p.version, p.profile.learner.description, p.profile.targetHours, p.derivedFromAcademic.untouched, p.derivedFromAcademic.owners.description], [3, 'Trabajadores del área contable de una pyme', 48, false, 'user'], 'perfil');
      const f = await facts.getFacts(cid, OWNER);
      eq(f.conflicts.map((c) => c.field), ['pedagogy.description'], 'conflicto del campo, nada más');
    });

    await check('SS9 cambiar solo el enfoque deja lo del documento «intacto»: el contexto nuevo se deriva', async () => {
      const cid = await newCourse('Enfoque');
      await profiles.append(cid, OWNER, 'academic', ctx);
      const p1 = (await ped(cid)).profile;
      await profiles.append(cid, OWNER, 'pedagogy', { ...p1, primaryApproach: 'competencias', designPreferences: { emphasis: 'application' } });
      eq((await ped(cid)).derivedFromAcademic.untouched, true, 'el enfoque no cuenta como edición');
      const ctx2 = JSON.parse(JSON.stringify(ctx));
      ctx2.hours.total = { ...ctx2.hours.total, value: 48 };
      const r = await profiles.append(cid, OWNER, 'academic', ctx2);
      eq(r.derivedPedagogy.applied, true, 'derivado');
      const p = (await ped(cid)).profile;
      eq([p.targetHours, p.primaryApproach, p.designPreferences], [48, 'competencias', { emphasis: 'application' }], 'horas nuevas; enfoque y preferencias se conservan');
    });

    await check('SS11 horas antes del documento: se respetan y lo demás se llena; «Usar los datos del documento» las reemplaza', async () => {
      const cid = await newCourse('Horas primero');
      await profiles.append(cid, OWNER, 'pedagogy', { ...emptyPedFor(), targetHours: 40 });
      const r = await profiles.append(cid, OWNER, 'academic', ctx);
      eq([r.derivedPedagogy.applied, r.derivedPedagogy.kept], [true, ['targetHours']], 'deriva y respeta las horas');
      let p = (await ped(cid)).profile;
      eq([p.targetHours, p.learningOutcomes.do.length > 0, p.learner.educationLevel !== null], [40, true, true], 'estudiante y resultados del documento, 40 h del docente');
      let f = await facts.getFacts(cid, OWNER);
      eq([f.targetHours.value, f.conflicts.map((c) => c.field)], [40, ['pedagogy.targetHours']], 'conflicto de horas visible');
      const u = await profiles.useDocumentInPedagogy(cid, OWNER, ['targetHours']);
      eq([u.applied, u.changes], [true, ['targetHours']], 'decisión explícita');
      p = (await ped(cid)).profile;
      f = await facts.getFacts(cid, OWNER);
      eq([p.targetHours, f.conflicts, (await ped(cid)).derivedFromAcademic.owners.targetHours], [64, [], 'document'], 'ahora las horas son del documento');
      await rejectsRe(profiles.useDocumentInPedagogy(cid, OWNER, ['nada']), /INVALID_FIELDS/, 'campos inválidos', 400);
    });

    await check('SS12 perfil anterior a 8.1 igual al documento: cuenta como del documento y se sigue actualizando', async () => {
      const cid = await newCourse('Pre 8.1');
      await ds.query(`insert into public.course_profiles (course_id, kind, version, data, sha256) select $1, kind, version, data, sha256 from public.course_profiles where false`, [cid]);
      const sugg = A.suggestProfileFromContext(ctx, null).profile;
      await profiles.append(cid, OWNER, 'academic', ctx);
      await ds.query(`update public.courses set metadata = metadata - 'pedagogyDerivation' where id = $1`, [cid]); // como si fuera anterior a 8.1
      eq((await ped(cid)).derivedFromAcademic, undefined, 'sin registro');
      const ctx2 = JSON.parse(JSON.stringify(ctx));
      ctx2.hours.total = { ...ctx2.hours.total, value: 48 };
      const r = await profiles.append(cid, OWNER, 'academic', ctx2);
      eq([r.derivedPedagogy.applied, r.derivedPedagogy.changes, r.derivedPedagogy.kept], [true, ['targetHours'], []], 'igual al documento → del documento');
      eq((await ped(cid)).profile.targetHours, 48, 'actualizado');
      assert(sugg.targetHours === 64, 'fixture');
    });

    await check('SS13 estudiante congelado en el Blueprint (con Actividades de Aplicación) → alinea el contexto del run', async () => {
      const cid = await newCourse('Blueprint');
      await profiles.append(cid, OWNER, 'academic', ctx);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title, objective, exam_enabled) values ($1, 0, 'Costos', 'Calcular costos de producción', true) returning id`, [cid]);
      await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled, application_minutes) values ($1, $2, 0, 'Elementos del costo', 'Identificar los elementos del costo', true, true, 60)`, [cid, m.id]);
      const lock = await blueprints.lock(cid, OWNER, Number((await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c));
      const [bp] = await ds.query(`select id from public.course_blueprints where course_id = $1 order by id desc limit 1`, [cid]);
      const learner = await FDB.loadFrozenLearner(ds, cid, bp.id);
      assert(lock.blueprint && learner && learner.educationLevel, 'el Blueprint congeló al estudiante: ' + JSON.stringify(learner));
      eq(learner.educationLevel, (await ped(cid)).profile.learner.educationLevel, 'el del perfil derivado');
      const run = { nombre: 'C', sector: 'S', pais: 'Colombia', contexto: 'Universitario — x', nivel: 'Avanzado — y', tono: 't', obj: 'o' };
      const al = CF.alignCourseContextWithSnapshot(run, learner);
      eq(CF.contextLevelOf(al.context.contexto), learner.educationLevel, 'contenido y Actividades de Aplicación: el mismo nivel');
      eq(await FDB.loadFrozenLearner(ds, cid, 999999), null, 'otro Blueprint: nada');
    });

    await check('SS10 lectura avanzada: estimar sin proveedor, consentimiento obligatorio, mismo extractor, gasto registrado', async () => {
      const cid = await newCourse('Escaneado');
      const pdf = await F.fixture('consistent', 'pdf');
      const files = [{ name: 'microcurriculo-escaneado.pdf', dataBase64: pdf.toString('base64') }];
      delete process.env.ACADEMIC_ADVANCED_EXTRACTION_ENABLED;
      const est = await acx.extractAdvanced(cid, OWNER, { files, mode: 'estimate' });
      eq([est.available, est.providersCalled, transcribeCalls], [false, 0, 0], 'estimar: sin proveedor; apagada en este entorno');
      assert(est.pages >= 1 && est.estimateUsd.max > est.estimateUsd.min, 'páginas y rango');
      await rejectsRe(acx.extractAdvanced(cid, OWNER, { files, mode: 'run', acceptedMaxUsd: 99 }), /ADVANCED_DISABLED/, 'apagada', 409);
      process.env.ACADEMIC_ADVANCED_EXTRACTION_ENABLED = 'true';
      await rejectsRe(acx.extractAdvanced(cid, OWNER, { files, mode: 'run' }), /ESTIMATE_NOT_ACCEPTED/, 'sin aceptar', 409);
      await rejectsRe(acx.extractAdvanced(cid, OWNER, { files, mode: 'run', acceptedMaxUsd: est.estimateUsd.max - 0.01 }), /ESTIMATE_NOT_ACCEPTED/, 'aceptó menos', 409);
      eq(transcribeCalls, 0, 'sin consentimiento no se llama al proveedor');
      await rejectsRe(acx.extractAdvanced(cid, OWNER, { files: [{ name: 'a.docx', dataBase64: Buffer.from('PK').toString('base64') }], mode: 'estimate' }), /ADVANCED_ONLY_PDF/, 'solo PDF', 400);
      const run = await acx.extractAdvanced(cid, OWNER, { files, mode: 'run', acceptedMaxUsd: est.estimateUsd.max });
      eq(transcribeCalls, 1, 'una transcripción');
      assert(run.draft.outcomes.length > 0 && run.draft.units.length > 0, 'el MISMO extractor arma el contexto desde la transcripción');
      eq([run.quality.sufficient, run.draft.documents[0].name], [true, 'microcurriculo-escaneado (lectura avanzada).md'], 'calidad y marca de lectura avanzada');
      eq([charges.length, charges[0].operation, charges[0].externalOperationId, charges[0].usage.output_tokens, charges[0].billingAccount], [1, 'llm.academic_extraction', 'msg_fake_1', 3000, 'cursia'], 'gasto registrado en FinOps');
      fakeTruncated = true;
      await rejectsRe(acx.extractAdvanced(cid, OWNER, { files, mode: 'run', acceptedMaxUsd: est.estimateUsd.max }), /ADVANCED_TRUNCATED/, 'truncada', 400);
      eq(charges.length, 2, 'el gasto de una lectura truncada también queda registrado');
      fakeTruncated = false;
      fakeText = '[ilegible] [ilegible]';
      await rejectsRe(acx.extractAdvanced(cid, OWNER, { files, mode: 'run', acceptedMaxUsd: est.estimateUsd.max }), /ADVANCED_UNREADABLE/, 'ilegible', 400);
      const plain = await acx.extract(cid, OWNER, { files: [{ name: 'micro.docx', dataBase64: (await F.fixture('consistent', 'docx')).toString('base64') }] });
      eq([plain.quality.sufficient, plain.quality.advancedAvailable], [true, false], '/extract informa la calidad');
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    for (const [k, v] of [['DYNAMIC_COURSE_STRUCTURE', saved.flag], ['DYNAMIC_V2_ALLOWED_OWNERS', saved.allow], ['ALLOW_UNOWNED_COURSES', saved.unowned], ['ACADEMIC_ADVANCED_EXTRACTION_ENABLED', saved.adv], ['DYNAMIC_MANIFEST_RULES_VERSION', saved.rules], ['DYNAMIC_ACTIVITY_TYPE_RULES', saved.atr]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
