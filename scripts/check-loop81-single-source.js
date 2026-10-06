#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.1 · Una sola fuente de verdad + cargador único. Contra el código COMPILADO en dist/ ("npm run build" antes).
// USD 0: sin red, sin proveedores (la lectura avanzada usa un transcriptor FALSO).
//
// Parte pura:
//   SS1 pedido del curso: normalización, parseo estricto, chips de Datos → vocabulario del motor
//   SS2 «Lo que sabemos del curso»: autoridad documento > perfil > usuario, orígenes y conflictos
//   SS3 contexto congelado: sin documento ni perfil queda IDÉNTICO; el nivel del documento y los previos del perfil
//       prevalecen sobre Datos; objetivo vacío ← documento
//   SS4 derivación del perfil: intacto / vacío / editado a mano
//   SS5 calidad de la extracción (escaneo, sin lo esencial) y costo estimado de la lectura avanzada (rango, sin red)
// Parte DB (Postgres 16 local desechable; se salta SOLO con --pure-only, y lo dice):
//   SS6 pedido del curso: PUT/GET, idempotente, otro dueño 404, legacy 400
//   SS7 guardar el contexto deriva el perfil pedagógico SOLO (sin «Usar en el perfil»): 64 h, resultados, nivel
//   SS8 el docente cambia a mano el estudiante → un contexto nuevo NO lo pisa y «Lo que sabemos» informa el conflicto
//   SS9 guardar el enfoque sin tocar lo del documento lo deja «intacto»: el contexto nuevo sí se deriva
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
    const solo = CF.resolveCourseFacts({ courseTitle: 'Curso sin título', institutionId: null, brief, academic: null, pedagogy: null, derivation: null });
    eq([solo.title.value, solo.title.source, solo.topic.source, solo.educationLevel.value, solo.educationLevel.source, solo.priorKnowledge.value, solo.targetHours.value, solo.conflicts], ['Contabilidad de Costos', 'user', 'user', 'technical', 'user', 'none', null, []], 'solo el pedido');
    const ped = { ...emptyPed(), targetHours: 48 };
    const withDoc = CF.resolveCourseFacts({ courseTitle: 'x', institutionId: 'inst-1', brief: { ...brief, fields: { ...brief.fields, contexto: 'Universitario — x' } }, academic: { version: 1, context: ctx }, pedagogy: { version: 1, profile: ped }, derivation: null });
    eq(withDoc.educationLevel.source, 'document', 'el nivel del documento manda');
    eq(withDoc.outcomes.source, 'document', 'resultados del documento');
    eq([withDoc.targetHours.value, withDoc.targetHours.source], [48, 'profile'], 'horas: dueño = perfil');
    // El perfil trae horas puestas a mano y no hay registro de derivación (perfil anterior a 8.1): se respeta y se informa.
    eq(withDoc.conflicts.map((c) => c.field).sort(), ['educationLevel', 'pedagogy', 'targetHours'], 'conflictos de nivel, perfil y horas a la vista');
    eq([withDoc.document.present, withDoc.document.contextVersion, withDoc.institutionId], [true, 1, 'inst-1'], 'documento e institución');
  });

  await check('SS3 contexto congelado: idéntico sin fuentes; documento y perfil prevalecen sobre Datos', () => {
    const run = { nombre: 'C', sector: 'S', pais: 'Colombia', contexto: BRIEF.contexto, nivel: BRIEF.nivel, tono: 'x', obj: '' };
    const none = CF.alignCourseContextWithFacts(run, CF.resolveCourseFacts({ courseTitle: 'C', institutionId: null, brief, academic: null, pedagogy: null, derivation: null }));
    assert(none.context === run && none.changed.length === 0, 'sin documento ni perfil: el mismo objeto (mismo hash)');
    const ped = { ...emptyPed(), learner: { ...emptyPed().learner, priorKnowledge: 'advanced' } };
    const facts = CF.resolveCourseFacts({ courseTitle: 'C', institutionId: null, brief, academic: { version: 1, context: ctx }, pedagogy: { version: 1, profile: ped }, derivation: null });
    const al = CF.alignCourseContextWithFacts(run, facts);
    const docLevel = ctx.identity.educationLevel.value && ctx.identity.educationLevel.value.level;
    eq(al.changed.includes('nivel'), true, 'previos del perfil');
    assert(/^Avanzado/.test(al.context.nivel), 'nivel = perfil');
    if (docLevel && docLevel !== 'technical') assert(al.changed.includes('contexto'), 'contexto = documento');
    const noObj = CF.resolveCourseFacts({ courseTitle: 'C', institutionId: null, brief: { ...brief, fields: { ...brief.fields, obj: undefined } }, academic: { version: 1, context: ctx }, pedagogy: null, derivation: null });
    if (ctx.identity.generalObjective.status !== 'missing') {
      const a2 = CF.alignCourseContextWithFacts(run, noObj);
      eq([a2.changed.includes('obj'), a2.context.obj.length > 0], [true, true], 'objetivo vacío (sin objetivo en Datos) ← documento');
    }
    eq(CF.alignCourseContextWithFacts({ ...run, obj: 'El mío' }, noObj).context.obj, 'El mío', 'un objetivo escrito nunca se reemplaza');
    eq(run.nivel, BRIEF.nivel, 'no muta el original');
  });

  await check('SS4 derivación del perfil: vacío / intacto / editado a mano', () => {
    const sugg = A.suggestProfileFromContext(ctx, null).profile;
    const rec = { academicVersion: 1, subsetSha: CF.derivedSubsetSha(sugg) };
    eq([CF.pedagogyDerivedUntouched(null, null), CF.pedagogyDerivedUntouched(emptyPed(), null)], [true, true], 'sin perfil o vacío');
    eq(CF.pedagogyDerivedUntouched(sugg, rec), true, 'intacto');
    eq(CF.pedagogyDerivedUntouched({ ...sugg, primaryApproach: 'competencias', designPreferences: { emphasis: 'depth' } }, rec), true, 'cambiar el enfoque no es editar lo del documento');
    eq(CF.pedagogyDerivedUntouched({ ...sugg, learner: { ...sugg.learner, description: 'Otros estudiantes' } }, rec), false, 'editado a mano');
    eq(CF.pedagogyDerivedUntouched(sugg, null), false, 'con datos y sin registro (perfil anterior a 8.1): se respeta');
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
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, unowned: process.env.ALLOW_UNOWNED_COURSES, adv: process.env.ACADEMIC_ADVANCED_EXTRACTION_ENABLED };
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
      eq(p.derivedFromAcademic, { academicVersion: 1, untouched: true }, 'GET pedagogy informa la derivación');
      const f = await facts.getFacts(cid, OWNER);
      eq([f.outcomes.source, f.targetHours.value, f.pedagogy.derivedFromDocument, f.conflicts], ['document', 64, true, []], 'Lo que sabemos: documento, sin conflictos');
      const again = await profiles.append(cid, OWNER, 'academic', ctx);
      eq([again.created, (await ped(cid)).version], [false, 1], 're-guardar el mismo contexto no crea versiones');
    });

    await check('SS8 el docente cambia a mano el estudiante → un contexto nuevo NO lo pisa y se informa el conflicto', async () => {
      const cid = await newCourse('Editado');
      await profiles.append(cid, OWNER, 'academic', ctx);
      const p1 = (await ped(cid)).profile;
      await profiles.append(cid, OWNER, 'pedagogy', { ...p1, learner: { ...p1.learner, description: 'Trabajadores del área contable de una pyme' } });
      const ctx2 = JSON.parse(JSON.stringify(ctx));
      ctx2.hours.total = { ...ctx2.hours.total, value: 48 };
      const r = await profiles.append(cid, OWNER, 'academic', ctx2);
      eq([r.created, r.derivedPedagogy], [true, { applied: false, reason: 'pedagogy_edited' }], 'no se derivó');
      const p = await ped(cid);
      eq([p.version, p.profile.learner.description, p.profile.targetHours, p.derivedFromAcademic.untouched], [2, 'Trabajadores del área contable de una pyme', 64, false], 'lo del docente sigue');
      const f = await facts.getFacts(cid, OWNER);
      assert(f.conflicts.some((c) => c.field === 'pedagogy') && f.conflicts.some((c) => c.field === 'targetHours'), 'conflictos a la vista: ' + JSON.stringify(f.conflicts.map((c) => c.field)));
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
    for (const [k, v] of [['DYNAMIC_COURSE_STRUCTURE', saved.flag], ['DYNAMIC_V2_ALLOWED_OWNERS', saved.allow], ['ALLOW_UNOWNED_COURSES', saved.unowned], ['ACADEMIC_ADVANCED_EXTRACTION_ENABLED', saved.adv]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
