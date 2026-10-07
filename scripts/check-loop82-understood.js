#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.2 · «Lo que entendimos»: contexto propuesto sin documento y edición de resultados. Contra dist/ ("npm run build").
// USD 0: sin red ni proveedores (la interpretación del pedido corre en el cliente; aquí solo se guarda lo interpretado).
//
// Parte pura:
//   PC1 propuesta → contexto sin documentos, cada dato `inferred` con su regla; Bloom/dominio; limpia y deduplica
//   PC2 la propuesta nunca reemplaza un contexto que viene de un documento (DOCUMENT_CONTEXT)
//   PC3 editar resultados: lo que no cambió conserva origen y cita; lo editado conserva el id y queda «escrito por ti»;
//       nuevos con ids siguientes; vínculos de unidades/evaluaciones a resultados quitados se limpian; errores claros
//   PC4 «Sí, usar estos»: los propuestos (y nombre, estudiante, competencias propuestos) quedan confirmados; los del
//       documento no cambian
//   PC5 «Lo que sabemos»: orígenes por resultado (documento / propuesto / tuyo), sin documento no hay «documento» ni
//       conflictos contra él
// Parte DB (Postgres 16 local desechable; --pure-only la salta y lo dice):
//   PC6 guardar la propuesta: versión del contexto + perfil pedagógico derivado; «Lo que sabemos» = propuesto
//   PC7 409 sobre un contexto de documento; 409 con versión vieja; otro dueño 404; legacy 400
//   PC8 editar y confirmar resultados por HTTP de servicio; quitar un resultado poda el vínculo del capítulo
//   PC9 subir después un documento reemplaza la propuesta (el documento manda)
//
// Uso: node scripts/check-loop82-understood.js [--pure-only] [path/to/dist]
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
const A = loadDist('modules/academic-context/index.js');
const F = require('./lib/academic-fixtures.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
function throwsRe(fn, re, m) {
  try { fn(); } catch (err) { assert(re.test(String(err && err.message)), `${m}: error inesperado «${err && err.message}»`); return; }
  throw new Error(`${m}: no falló`);
}
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

const PROPOSAL = {
  subjectName: 'Excel básico para la gestión',
  generalObjective: 'Usar hojas de cálculo para organizar y analizar datos de gestión',
  learnerProfile: 'Estudiantes de primeros semestres de Administración con uso básico del computador',
  priorKnowledge: ['Uso básico del computador', 'uso básico del computador', '  '],
  outcomes: ['Organiza datos de gestión en tablas con formato y validación', 'Calcula indicadores con fórmulas y funciones', 'Explica cuándo usar cada tipo de gráfico', 'Organiza datos de gestión en tablas con formato y validación'],
  competencies: ['Gestiona información con hojas de cálculo'],
};
const BRIEF = { briefVersion: 1, fields: { obj: 'Quiero un curso de Excel básico para estudiantes de Administración', contexto: 'Universitario — x' }, updatedAt: 't' };

(async () => {
  console.log('Parte pura');
  const doc = (await A.extractAcademicContext([{ name: 'micro.docx', data: await F.fixture('consistent', 'docx') }])).context;

  await check('PC1 propuesta → contexto sin documentos, inferido con su regla, Bloom y dominio', () => {
    const c = A.buildProposedContext(null, PROPOSAL);
    eq(c.documents, [], 'sin documentos');
    eq(c.outcomes.map((o) => [o.id, o.status, o.basis, o.domain]), [
      ['RA1', 'inferred', A.PROPOSAL_BASIS, 'do'], ['RA2', 'inferred', A.PROPOSAL_BASIS, 'do'], ['RA3', 'inferred', A.PROPOSAL_BASIS, 'know']], 'resultados deduplicados con dominio');
    eq([c.outcomes[1].level, c.outcomes[2].level], ['apply', 'understand'], 'nivel de Bloom por el verbo');
    eq([c.identity.subjectName.status, c.identity.subjectName.value, c.learner.priorKnowledge.value], ['inferred', PROPOSAL.subjectName, ['Uso básico del computador']], 'identidad y previos');
    eq(c.competencies.map((x) => [x.id, x.status]), [['CO1', 'inferred']], 'competencias');
    eq(c.identity.educationLevel.status, 'missing', 'el nivel no se inventa (lo trae el pedido)');
    const v = A.validateAcademicContext(c);
    assert(v.canProceed, 'el contexto propuesto pasa la validación: ' + JSON.stringify(v).slice(0, 300));
    throwsRe(() => A.buildProposedContext(null, { outcomes: ['  ', ''] }), /NO_OUTCOMES/, 'sin resultados');
  });

  await check('PC2 la propuesta nunca reemplaza un contexto de documento', () => {
    throwsRe(() => A.buildProposedContext(doc, PROPOSAL), /DOCUMENT_CONTEXT/, 'documento manda');
    const prev = A.buildProposedContext(null, PROPOSAL);
    eq(A.buildProposedContext(prev, { outcomes: ['Diseña un tablero de control'] }).outcomes.length, 1, 'una propuesta nueva reemplaza la anterior (sin confirmar)');
    // Review L82 I1: lo que el docente escribió o confirmó nunca lo reemplaza una propuesta.
    throwsRe(() => A.buildProposedContext(A.rewriteOutcomes(null, [{ text: 'Aplica fórmulas básicas' }]), PROPOSAL), /USER_CONTEXT/, 'resultados escritos por el docente');
    const confirmed = A.rewriteOutcomes(prev, prev.outcomes.map((o) => ({ id: o.id, text: o.text })), true);
    throwsRe(() => A.buildProposedContext(confirmed, PROPOSAL), /USER_CONTEXT/, 'propuesta confirmada');
    eq([A.isReplaceableByProposal(null), A.isReplaceableByProposal(prev), A.isReplaceableByProposal(confirmed), A.isReplaceableByProposal(doc)], [true, true, false, false], 'reemplazable solo vacío o propuesta sin confirmar');
  });

  await check('PC3 editar resultados: ids y orígenes conservados, editados «tuyos», vínculos limpios, errores claros', () => {
    const before = doc.outcomes;
    assert(before.length >= 3, 'el microcurrículo trae resultados');
    const edits = [{ id: before[0].id, text: before[0].text }, { id: before[1].id, text: 'Calcula el costo unitario de un producto' }, { text: 'Propone mejoras al control de costos' }];
    const c = A.rewriteOutcomes(doc, edits);
    eq(c.outcomes[0], before[0], 'el que no cambió queda idéntico (con su cita)');
    eq([c.outcomes[1].id, c.outcomes[1].status, c.outcomes[1].sources, c.outcomes[1].level], [before[1].id, 'provided', [], 'apply'], 'editado: mismo id, escrito por ti');
    const maxId = Math.max(...before.map((o) => Number(o.id.slice(2))));
    eq([c.outcomes[2].id, c.outcomes[2].status, c.outcomes[2].domain], [`RA${maxId + 1}`, 'provided', 'do'], 'nuevo con el id siguiente');
    const gone = new Set(before.slice(2).map((o) => o.id));
    const refs = [...c.units.flatMap((u) => [...u.outcomeIds, ...u.contents.flatMap((x) => x.outcomeIds)]), ...c.evaluation.flatMap((e) => e.outcomeIds)];
    assert(!refs.some((id) => gone.has(id)), 'sin vínculos a resultados quitados');
    assert(A.validateAcademicContext(c).canProceed, 'sigue siendo válido');
    eq(doc.outcomes, before, 'no muta el original');
    throwsRe(() => A.rewriteOutcomes(doc, []), /NO_OUTCOMES/, 'vacío');
    throwsRe(() => A.rewriteOutcomes(doc, [{ text: ' ' }]), /EMPTY_OUTCOME/, 'texto vacío');
    throwsRe(() => A.rewriteOutcomes(doc, [{ id: before[0].id, text: 'a b' }, { id: before[0].id, text: 'c d' }]), /DUPLICATE_OUTCOME_ID/, 'id repetido');
    const fromNothing = A.rewriteOutcomes(null, [{ text: 'Aplica fórmulas básicas' }, { id: 'RA9', text: 'Explica el formato condicional' }]);
    eq(fromNothing.outcomes.map((o) => [o.id, o.status]), [['RA1', 'provided'], ['RA2', 'provided']], 'sin contexto: escritos por ti; un id desconocido no se respeta');
  });

  await check('PC4 «Sí, usar estos»: lo propuesto queda confirmado; lo del documento no cambia', () => {
    const p = A.buildProposedContext(null, PROPOSAL);
    const ok = A.rewriteOutcomes(p, p.outcomes.map((o) => ({ id: o.id, text: o.text })), true);
    eq(ok.outcomes.map((o) => [o.id, o.status, 'basis' in o]), [['RA1', 'provided', false], ['RA2', 'provided', false], ['RA3', 'provided', false]], 'confirmados');
    eq([ok.identity.subjectName.status, ok.learner.profile.status, ok.competencies[0].status], ['provided', 'provided', 'provided'], 'nombre, estudiante y competencias confirmados');
    assert(A.validateAcademicContext(ok).canProceed, 'válido');
    const same = A.rewriteOutcomes(doc, doc.outcomes.map((o) => ({ id: o.id, text: o.text })), true);
    eq(same.outcomes, doc.outcomes, 'los del documento no cambian');
    // Review L82 I2: resultados INFERIDOS por el extractor (objetivos del documento) conservan su cita al confirmar.
    const docInf = JSON.parse(JSON.stringify(doc));
    docInf.outcomes = docInf.outcomes.map((o) => ({ ...o, status: 'inferred', basis: 'objetivo del documento usado como resultado' }));
    eq(A.rewriteOutcomes(docInf, docInf.outcomes.map((o) => ({ id: o.id, text: o.text })), true).outcomes, docInf.outcomes, 'inferidos del documento: intactos');
  });

  await check('PC5 «Lo que sabemos»: origen por resultado; sin documento no hay «documento» ni conflictos contra él', () => {
    const p = A.buildProposedContext(null, PROPOSAL);
    const ped = { pedagogyProfileVersion: 1, primaryApproach: null, secondaryApproaches: [], learner: { description: 'Mi estudiante', ageGroup: null, educationLevel: null, priorKnowledge: null, experience: null }, learningOutcomes: { know: [], do: [], competencies: [] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: 32 };
    const f = CF.resolveCourseFacts({ courseTitle: 'Curso sin título', institutionId: null, brief: BRIEF, academic: { version: 1, context: p }, pedagogy: { version: 1, profile: ped }, derivation: null, suggested: A.suggestProfileFromContext(p, null).profile });
    eq([f.document.present, f.document.proposed, f.units.value], [false, true, null], 'sin documento, propuesto');
    eq([f.outcomes.source, f.outcomes.value.map((o) => o.origin)], ['inferred', ['proposed', 'proposed', 'proposed']], 'resultados propuestos');
    eq([f.title.value, f.title.source], [PROPOSAL.subjectName, 'inferred'], 'nombre propuesto');
    eq(f.topic.source, 'user', 'el tema lo dijo el usuario');
    eq(f.conflicts, [], 'sin conflictos contra un documento inexistente');
    const fi = CF.resolveCourseFacts({ courseTitle: null, institutionId: null, brief: { ...BRIEF, fields: { ...BRIEF.fields, nombre: 'Excel', sector: 'Administración', pais: 'Colombia', inferidos: 'sector, pais' } }, academic: null, pedagogy: null, derivation: null, suggested: null });
    eq([fi.title.source, fi.sector.source, fi.country.source], ['user', 'inferred', 'inferred'], 'lo que llenó Cursia en el pedido se ve como inferido');
    eq(f.pedagogy.derivedFromDocument, false, 'no se presenta como «del documento»');
    const ok = A.rewriteOutcomes(p, [{ id: 'RA1', text: p.outcomes[0].text }, { text: 'Diseña un tablero de control' }], true);
    const f2 = CF.resolveCourseFacts({ courseTitle: null, institutionId: null, brief: BRIEF, academic: { version: 2, context: ok }, pedagogy: null, derivation: null, suggested: null });
    eq([f2.document.proposed, f2.outcomes.source, f2.outcomes.value.map((o) => o.origin)], [false, 'user', ['user', 'user']], 'confirmados = tuyos');
    const f3 = CF.resolveCourseFacts({ courseTitle: null, institutionId: null, brief: BRIEF, academic: { version: 1, context: doc }, pedagogy: null, derivation: null, suggested: null });
    eq([f3.document.present, f3.document.proposed, f3.outcomes.source, f3.outcomes.value.every((o) => o.origin === 'document')], [true, false, 'document', true], 'con documento, como en 8.1');
    const docInf = JSON.parse(JSON.stringify(doc));
    docInf.outcomes = docInf.outcomes.map((o) => ({ ...o, status: 'inferred', basis: 'objetivo del documento usado como resultado' }));
    const f4 = CF.resolveCourseFacts({ courseTitle: null, institutionId: null, brief: BRIEF, academic: { version: 1, context: docInf }, pedagogy: null, derivation: null, suggested: null });
    eq([f4.document.proposed, f4.outcomes.source, f4.outcomes.value.every((o) => o.origin === 'document')], [false, 'document', true], 'review L82 I2: inferidos del documento siguen siendo del documento');
  });

  if (PURE_ONLY) console.log('\n⚠️  --pure-only: se SALTÓ la parte DB (no cuenta como probada).');
  else await dbChecks(doc);
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

async function dbChecks(doc) {
  console.log('\nParte DB');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseFactsService } = loadDist('modules/course-facts/course-facts.service.js');
  const { AcademicContextService } = loadDist('modules/academic-context/academic-context.service.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-loop82-pg16-'));
  const DB = 'loop82db';
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
    const acxP = new AcademicContextService(ds, coursesStub, ledger, transcriber, profiles);
    const ped = async (cid) => (await profiles.getCurrent(cid, OWNER, 'pedagogy'));
    const acad = async (cid) => (await profiles.getCurrent(cid, OWNER, 'academic'));

    await check('PC6 guardar la propuesta: contexto propuesto + perfil derivado; «Lo que sabemos» = propuesto', async () => {
      const cid = await newCourse('Sin documento');
      await facts.putBrief(cid, OWNER, { obj: BRIEF.fields.obj, contexto: 'Universitario — estudiantes de pregrado universitario, con rigor académico y pensamiento crítico' });
      const r = await acxP.saveProposal(cid, OWNER, { expectedVersion: 0, ...PROPOSAL });
      eq([r.created, r.profile.version, r.derivedPedagogy && r.derivedPedagogy.applied], [true, 1, true], 'contexto v1 y perfil derivado');
      const p = await ped(cid);
      eq([p.profile.learningOutcomes.do.length, p.profile.learningOutcomes.know.length, p.profile.learner.description], [2, 1, PROPOSAL.learnerProfile], 'el perfil recibe los resultados y el estudiante propuestos');
      const f = await facts.getFacts(cid, OWNER);
      eq([f.document.present, f.document.proposed, f.outcomes.source, f.outcomes.value.length, f.educationLevel.value, f.conflicts], [false, true, 'inferred', 3, 'university', []], 'Lo que sabemos');
      eq(charges.length + transcribeCalls, 0, 'USD 0: ningún proveedor');
    });

    await check('PC7 409 sobre documento o versión vieja; otro dueño 404; legacy 400', async () => {
      const cid = await newCourse('Con documento');
      await profiles.append(cid, OWNER, 'academic', doc);
      await rejectsRe(acxP.saveProposal(cid, OWNER, { expectedVersion: 1, ...PROPOSAL }), /DOCUMENT_CONTEXT/, 'el documento manda', 409);
      await rejectsRe(acxP.saveProposal(cid, OWNER, { expectedVersion: 0, ...PROPOSAL }), /ACADEMIC_CHANGED/, 'versión vieja', 409);
      await rejectsRe(acxP.saveProposal(cid, OTHER, { expectedVersion: 1, ...PROPOSAL }), /not found/, 'otro dueño', 404);
      const [legacy] = await ds.query(`insert into public.courses (owner_id, title) values ($1, 'Legacy') returning id`, [OWNER]);
      await rejectsRe(acxP.saveProposal(legacy.id, OWNER, { expectedVersion: 0, ...PROPOSAL }), /solo admite cursos "dynamic"/, 'legacy', 400);
      eq((await acad(cid)).version, 1, 'nada se guardó');
    });

    await check('PC8 editar y confirmar resultados; quitar uno poda el vínculo del capítulo', async () => {
      const cid = await newCourse('Editar resultados');
      await acxP.saveProposal(cid, OWNER, { expectedVersion: 0, ...PROPOSAL });
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'M1') returning id`, [cid]);
      const [ch] = await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, outcome_ids) values ($1, $2, 0, 'C1', '["RA1","RA3"]'::jsonb) returning id`, [cid, m.id]);
      const r = await acxP.saveOutcomes(cid, OWNER, { expectedVersion: 1, outcomes: [{ id: 'RA1', text: PROPOSAL.outcomes[0] }, { id: 'RA2', text: 'Calcula indicadores de gestión con funciones' }] });
      eq([r.created, r.profile.version, (r.prunedOutcomeLinks || []).map((x) => x.removed)], [true, 2, [['RA3']]], 'versión 2 y vínculo a RA3 podado');
      const [after] = await ds.query(`select outcome_ids from public.course_chapters where id = $1`, [ch.id]);
      eq(after.outcome_ids, ['RA1'], 'el capítulo conserva RA1');
      const f = await facts.getFacts(cid, OWNER);
      eq(f.outcomes.value.map((o) => [o.id, o.origin]), [['RA1', 'proposed'], ['RA2', 'user']], 'orígenes');
      const ok = await acxP.saveOutcomes(cid, OWNER, { expectedVersion: 2, outcomes: f.outcomes.value.map((o) => ({ id: o.id, text: o.text })), accept: true });
      eq(ok.profile.version, 3, 'confirmar crea la versión 3');
      const f2 = await facts.getFacts(cid, OWNER);
      eq([f2.document.proposed, f2.outcomes.value.map((o) => o.origin)], [false, ['user', 'user']], 'confirmados');
      const again = await acxP.saveOutcomes(cid, OWNER, { expectedVersion: 3, outcomes: f2.outcomes.value.map((o) => ({ id: o.id, text: o.text })), accept: true });
      eq(again.created, false, 'confirmar dos veces no crea versiones');
      await rejectsRe(acxP.saveOutcomes(cid, OWNER, { expectedVersion: 1, outcomes: [{ text: 'x y' }] }), /ACADEMIC_CHANGED/, 'pestaña vieja', 409);
      await rejectsRe(acxP.saveProposal(cid, OWNER, { expectedVersion: 3, ...PROPOSAL }), /USER_CONTEXT/, 'review L82 I1: una propuesta no pisa lo confirmado', 409);
    });

    await check('PC9 subir después un documento reemplaza la propuesta (el documento manda)', async () => {
      const cid = await newCourse('Propuesta y luego documento');
      await acxP.saveProposal(cid, OWNER, { expectedVersion: 0, ...PROPOSAL });
      const r = await profiles.append(cid, OWNER, 'academic', doc, 1);
      eq([r.created, r.profile.version], [true, 2], 'el documento crea la versión 2');
      const f = await facts.getFacts(cid, OWNER);
      eq([f.document.present, f.document.proposed, f.outcomes.source, f.targetHours.value], [true, false, 'document', 64], 'ahora todo viene del documento');
      const p = await ped(cid);
      eq(p.profile.learningOutcomes.do.includes(PROPOSAL.outcomes[0]), false, 'los resultados propuestos dejaron el perfil (eran de Cursia)');
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
