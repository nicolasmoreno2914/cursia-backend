#!/usr/bin/env node
/* eslint-disable no-console */
// Fase 3 · Contexto académico (Context Package) — pruebas puras. USD 0: sin proveedores, sin base, red bloqueada.
//
//   AC1  modelo: forma estricta (claves, estados, fuentes, ids, límites), normalización canónica y sha estable
//   AC2  ingesta: el mismo microcurrículo en TXT, MD, DOCX y PDF da los mismos datos (resultados con nivel, competencias,
//        unidades con horas y vínculos, horas, evaluación, bibliografía, restricciones)
//   AC3  procedencia: lo encontrado trae extracto de la fuente; lo inferido trae su regla; lo ausente queda «missing»
//        (documento mínimo: nada inventado)
//   AC4  varios documentos: fusión en orden, conflictos con ambas fuentes, ids renumerados
//   AC5  validación: error / advertencia / faltante («El documento indica 64 horas, pero la suma… 48 horas»),
//        contradicciones, vínculos rotos, PDF sin texto, contexto vacío
//   AC6  contexto → perfil pedagógico: estudiante, nivel, saber / saber hacer, competencias, 64 h, métodos de evaluación;
//        conserva el enfoque; perfil válido
//   AC7  contexto → estructura: unidades → módulos, contenidos → capítulos (≤ 5, agrupados), objetivos = resultados,
//        vínculos del documento; sin unidades → sin propuesta
//   AC8  Blueprint v2: course.academicContext y chapter.outcomeIds SOLO con contexto / vínculos; vínculos rotos → error;
//        ida y vuelta canónica; sin contexto, el sha de siempre
//   AC9  brief del claim: resultados por item (capítulo, práctica, examen, final, proveedores no); ≤ 4000 caracteres;
//        sin contexto, el brief de siempre
//   AC10 huellas (R26): cambiar un vínculo regenera actividades, Actividades de Aplicación y exámenes, NUNCA el content
//   AC11 el contexto cambia el diseño real: 64 h con el microcurrículo → dentro de la tolerancia (con 3 × 3 no se
//        alcanzaba); el enfoque cambia cómo crece; Manifest válido; costo estimado
//   AC12 vínculos sugeridos para una estructura existente (nunca pisan los del docente)
//   AC13 0 llamadas de red medidas
//
// Uso: node scripts/check-academic-context.js [path/to/dist]   (después de npm run build)
'use strict';
const path = require('path');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const load = (rel) => require(path.join(distRoot, rel));
const A = load('modules/academic-context/index.js');
const AB = load('modules/academic-context/alignment-brief.js');
const SNAP = load('modules/course-blueprints/blueprint-snapshot.js');
const P = load('modules/pedagogy/index.js');
const GD = load('modules/pedagogy/generator-directives.js');
const FP = load('modules/invalidation/fingerprints.js');
const MB = load('modules/generation-manifests/generation-manifest-builder.js');
const CP = load('modules/course-profiles/course-profiles.js');
const F = require('./lib/academic-fixtures.js');
const PF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const A1 = JSON.stringify(a); const B1 = JSON.stringify(b); if (A1 !== B1) throw new Error(`${m}: esperado ${B1}, encontrado ${A1}`); };
const throwsRe = (fn, re, m) => { try { fn(); } catch (e) { if (re.test(e.message)) return; throw new Error(`${m}: error inesperado ${e.message}`); } throw new Error(`${m}: no lanzó`); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const codes = (v) => v.issues.map((i) => `${i.severity}:${i.code}`);

const FORMATS = ['txt', 'md', 'docx', 'pdf'];
const extract = async (variant, fmt) => A.extractAcademicContext([{ name: `micro.${fmt}`, data: await F.fixture(variant, fmt) }]);

/** Hechos del contexto que deben coincidir en todos los formatos. */
function facts(c) {
  return {
    subject: c.identity.subjectName.value,
    program: c.identity.program.value,
    level: c.identity.educationLevel.value && c.identity.educationLevel.value.level,
    outcomes: c.outcomes.map((o) => [o.id, o.level, o.domain, o.text]),
    competencies: c.competencies.map((o) => [o.id, o.text]),
    units: c.units.map((u) => [u.id, u.title, u.hours, u.outcomeIds, u.contents.map((x) => x.text)]),
    hours: [c.hours.total.status, c.hours.total.value, c.hours.weekly.value, c.hours.weeks.value, c.hours.credits.value, c.hours.components.map((h) => [h.kind, h.hours])],
    evaluation: c.evaluation.map((e) => [e.weightPct, e.outcomeIds]),
    bibliography: c.bibliography.length,
    constraints: c.constraints.value,
    prior: c.learner.priorKnowledge.value,
    learner: c.learner.profile.status,
    methodology: c.methodology.status,
  };
}

let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
/** Estructura (filas) desde la propuesta del contexto, con o sin vínculos. */
function rowsFromProposal(prop, { links = true } = {}) {
  const modules = [];
  const chapters = [];
  prop.modules.forEach((m, mi) => {
    const id = uuid();
    modules.push({ id, position: mi, title: m.title, objective: m.objective, description: m.description, exam_enabled: m.examEnabled });
    m.chapters.forEach((c, ci) => chapters.push({ id: uuid(), module_id: id, position: ci, title: c.title, objective: c.objective, description: c.description, video_enabled: c.videoEnabled, activity_enabled: c.activityEnabled, ...(links && c.outcomeIds.length ? { outcome_ids: c.outcomeIds } : {}) }));
  });
  return { modules, chapters };
}
const courseRef = (extra = {}) => ({ id: 7001, title: 'Contabilidad de Costos', finalExam: true, activityEngine: 'h5p', reviewCards: true, ...extra });
const profileOf = (k, extra = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[k].primaryApproach, secondaryApproaches: PF.profiles[k].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', ...extra,
});

(async () => {
  const C = {};
  for (const fmt of FORMATS) C[fmt] = (await extract('consistent', fmt)).context;
  const ctx = C.docx;

  await check('AC1 modelo: forma estricta, normalización canónica y sha estable', () => {
    const empty = A.emptyAcademicContext();
    eq(A.validateAcademicContextShape(empty), [], 'contexto vacío válido');
    eq(CP.validateProfile('academic', ctx, { finalExam: true }), [], 'course-profiles despacha academic');
    eq(CP.PROFILE_KINDS.includes('academic'), true, 'kind academic');
    const bad = (mut, code) => {
      const x = clone(ctx);
      mut(x);
      const errs = A.validateAcademicContextShape(x).map((e) => e.code);
      assert(errs.includes(code), `${code} esperado, encontrado ${JSON.stringify(errs.slice(0, 6))}`);
    };
    bad((x) => { x.extra = 1; }, 'UNKNOWN_FIELD');
    bad((x) => { x.outcomes[0].sources = []; }, 'FOUND_WITHOUT_SOURCE');
    bad((x) => { x.identity.educationLevel.basis = undefined; delete x.identity.educationLevel.basis; }, 'INFERRED_WITHOUT_BASIS');
    bad((x) => { x.methodology = { status: 'missing', value: 'algo', sources: [] }; }, 'MISSING_WITH_VALUE');
    bad((x) => { x.outcomes[1].id = 'RA1'; }, 'DUPLICATE_ID');
    bad((x) => { x.outcomes[0].id = 'R1'; }, 'INVALID_ID');
    bad((x) => { x.outcomes[0].sources[0].documentId = 'D9'; }, 'UNKNOWN_DOCUMENT');
    bad((x) => { x.units[0].contents[0].outcomeIds = ['XX1']; }, 'INVALID_OUTCOME_REF');
    bad((x) => { x.units[0].contents[0].id = 'U2.9'; }, 'CONTENT_ID_UNIT_MISMATCH');
    bad((x) => { x.outcomes[0].status = 'missing'; }, 'INVALID_STATUS');
    bad((x) => { x.methodology = { status: 'provided', value: 'Clases', sources: ctx.methodology.sources }; }, 'UNEXPECTED_SOURCE');
    bad((x) => { x.bibliography = Array.from({ length: 81 }, (_v, i) => ({ id: `B${i + 1}`, text: 'Ref', status: 'provided', sources: [] })); }, 'TOO_MANY_ITEMS');
    throwsRe(() => A.normalizeAcademicContext({ ...clone(ctx), academicContextVersion: 2 }), /ACADEMIC_CONTEXT_INVALID/, 'versión');
    // Orden de claves de jsonb: el sha no cambia.
    const reverseKeys = (v) => (Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])])) : v);
    const shuffled = reverseKeys(ctx);
    const reordered = clone(ctx); const t = reordered.identity; reordered.identity = { description: t.description, generalObjective: t.generalObjective, educationLevel: t.educationLevel, program: t.program, subjectName: t.subjectName };
    eq(A.academicContextSha256(A.normalizeAcademicContext(reordered)), A.academicContextSha256(ctx), 'sha independiente del orden de claves');
    eq(A.academicContextSha256(A.normalizeAcademicContext(shuffled)), A.academicContextSha256(ctx), 'sha (claves invertidas)');
    eq(CP.profileSha256(CP.normalizeProfile('academic', reordered)), A.academicContextSha256(ctx), 'sha de course-profiles = sha del contexto');
    // Editado por el docente: provided sin fuentes.
    const edited = clone(ctx); edited.methodology = { status: 'provided', value: 'Talleres semanales', sources: [] };
    eq(A.validateAcademicContextShape(edited), [], 'provided válido');
  });

  await check('AC2 ingesta: TXT, MD, DOCX y PDF dan los mismos datos del microcurrículo', () => {
    const want = facts(C.docx);
    for (const fmt of FORMATS) eq(facts(C[fmt]), want, `${fmt} = docx`);
    const c = ctx;
    eq(c.identity.subjectName.value, 'Contabilidad de Costos', 'asignatura');
    eq(c.outcomes.map((o) => `${o.id}:${o.level}:${o.domain}`), ['RA1:remember:know', 'RA2:apply:do', 'RA3:apply:do', 'RA4:apply:do', 'RA5:analyze:do', 'RA6:create:do'], 'resultados con nivel de Bloom');
    eq(c.competencies.map((o) => o.id), ['CO1', 'CO2'], 'competencias (CE1/CE2 → CO1/CO2)');
    eq(c.units.map((u) => [u.title, u.hours, u.outcomeIds, u.contents.length]), [
      ['Fundamentos de la contabilidad de costos', 12, ['RA1'], 4],
      ['Costeo de materiales y mano de obra', 14, ['RA2'], 4],
      ['Costos indirectos y costeo por órdenes', 14, ['RA3'], 4],
      ['Costeo por procesos', 12, ['RA4'], 3],
      ['Análisis costo-volumen-utilidad', 12, ['RA5', 'RA6'], 3],
    ], 'unidades');
    eq([c.hours.total.status, c.hours.total.value, c.hours.weekly.value, c.hours.weeks.value, c.hours.credits.value], ['found', 64, 4, 16, 2], 'horas');
    eq(c.hours.components.map((h) => [h.kind, h.hours]), [['contact', 32], ['autonomous', 32]], 'componentes de horas');
    eq(c.evaluation.map((e) => [e.weightPct, e.outcomeIds]), [[15, ['RA1']], [20, ['RA2']], [25, ['RA3']], [15, ['RA4']], [25, ['RA5', 'RA6']]], 'evaluación con pesos y vínculos');
    eq(c.evaluation[0].instrument, 'Taller de elementos del costo', 'instrumento sin el % ni los vínculos');
    eq(c.bibliography.length, 4, 'bibliografía');
    eq(c.constraints.value.length, 2, 'restricciones');
    eq(c.learner.priorKnowledge.value.length, 3, 'conocimientos previos');
    eq(c.documents[0].extractor.id, 'cursia-academic-extractor', 'extractor determinista');
  });

  await check('AC3 procedencia: encontrado con extracto, inferido con regla, faltante sin inventar', async () => {
    const o = ctx.outcomes[2];
    eq(o.status, 'found', 'RA3 encontrado');
    assert(o.sources[0].excerpt.includes('costeo por órdenes'), `extracto de la fuente: ${o.sources[0].excerpt}`);
    eq(o.sources[0].section, 'Resultados de aprendizaje', 'sección');
    eq(C.pdf.outcomes[2].sources[0].page !== null, true, 'PDF: número de página');
    eq(ctx.identity.educationLevel.status, 'inferred', 'nivel inferido del programa');
    assert(/programa/.test(ctx.identity.educationLevel.basis), 'regla declarada');
    const min = (await extract('minimal', 'docx')).context;
    eq(min.identity.subjectName.value, 'Seguridad y salud en el trabajo', 'asignatura del mínimo');
    eq([min.outcomes.length, min.competencies.length, min.evaluation.length, min.bibliography.length], [0, 0, 0, 0], 'nada inventado');
    eq([min.hours.total.status, min.learner.profile.status, min.methodology.status, min.identity.educationLevel.status], ['missing', 'missing', 'missing', 'missing'], 'faltantes');
    eq([min.units.length, min.units[0].status, min.units[0].title], [1, 'inferred', 'Contenidos'], 'una unidad inferida con el título de la sección');
    assert(/sin agruparlos en unidades/.test(min.units[0].basis), 'regla de la unidad inferida');
    // Total inferido (sin total en el documento): suma de componentes.
    const txt = F.toText('consistent').toString('utf8').replace(/Intensidad horaria total: 64 horas\n/, '');
    const inf = (await A.extractAcademicContext([{ name: 'sin-total.txt', data: Buffer.from(txt) }])).context;
    eq([inf.hours.total.status, inf.hours.total.value], ['inferred', 64], 'total = suma de componentes');
    assert(/suma de los componentes/.test(inf.hours.total.basis), 'regla del total');
  });

  await check('AC4 varios documentos: fusión en orden, conflictos con ambas fuentes, ids renumerados', async () => {
    const r = await A.extractAcademicContext([
      { name: 'minimo.docx', data: await F.fixture('minimal', 'docx') },
      { name: 'micro.pdf', data: await F.fixture('consistent', 'pdf') },
    ]);
    const c = r.context;
    eq(c.documents.map((d) => [d.id, d.mediaType]), [['D1', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['D2', 'application/pdf']], 'documentos');
    eq(c.identity.subjectName.value, 'Seguridad y salud en el trabajo', 'el primero gana');
    const k = c.conflicts.find((x) => x.path === 'identity.subjectName');
    assert(k && k.values.map((v) => v.source.documentId).join() === 'D1,D2', 'conflicto con ambas fuentes');
    eq(c.outcomes.length, 6, 'resultados del segundo documento');
    eq(c.units.length, 1, 'unidades: las del primer documento que las trae');
    assert(A.validateAcademicContext(c).issues.some((i) => i.code === 'CONTRADICTION'), 'la validación avisa la contradicción');
  });

  await check('AC5 validación: error / advertencia / faltante, con los mensajes del documento', async () => {
    const ok = A.validateAcademicContext(ctx);
    eq([ok.canProceed, ok.counts], [true, { error: 0, warning: 0, missing: 0 }], 'microcurrículo consistente: limpio');
    const bad = A.validateAcademicContext((await extract('inconsistent', 'docx')).context);
    eq(bad.canProceed, true, 'las advertencias no bloquean');
    for (const code of ['warning:HOURS_SUM_MISMATCH', 'warning:EVALUATION_WEIGHTS_NOT_100', 'warning:OUTCOME_WITHOUT_CONTENT', 'warning:OUTCOME_WITHOUT_EVALUATION', 'warning:DUPLICATE_OUTCOME', 'warning:CONTRADICTION']) {
      assert(codes(bad).includes(code), `${code} en ${codes(bad).join(',')}`);
    }
    eq(bad.issues.find((i) => i.code === 'HOURS_SUM_MISMATCH').message, 'El documento indica 64 horas, pero la suma de componentes reportada es 48 horas.', 'mensaje de horas');
    const min = A.validateAcademicContext((await extract('minimal', 'txt')).context);
    eq(min.counts, { error: 0, warning: 0, missing: 8 }, 'mínimo: solo faltantes');
    eq(min.issues.every((i) => i.severity === 'missing'), true, 'faltantes clasificados');
    const empty = A.validateAcademicContext(A.emptyAcademicContext());
    eq([empty.canProceed, codes(empty)[0]], [false, 'error:CONTEXT_EMPTY'], 'vacío: error');
    const broken = clone(ctx); broken.units[0].outcomeIds = ['RA9'];
    eq(A.validateAcademicContext(broken).issues.filter((i) => i.severity === 'error').map((i) => i.code), ['UNKNOWN_OUTCOME_REF'], 'vínculo roto: error');
    // PDF sin texto (p. ej. escaneado): nota y error claros, sin OCR ni proveedores.
    const PDFDocument = require('pdfkit');
    const blank = await new Promise((res) => { const d = new PDFDocument(); const ch = []; d.on('data', (x) => ch.push(x)); d.on('end', () => res(Buffer.concat(ch))); d.rect(50, 50, 100, 100).stroke(); d.end(); });
    const r = await A.extractAcademicContext([{ name: 'escaneado.pdf', data: blank }]);
    eq(r.notes.map((n) => n.code), ['DOCUMENT_WITHOUT_TEXT'], 'nota del PDF sin texto');
    eq(codes(A.validateAcademicContext(r.context))[0], 'error:DOCUMENT_WITHOUT_TEXT', 'error del PDF sin texto');
    // Un documento con vínculos a resultados que no define: se avisa y no se guardan.
    const txt = F.toText('consistent').toString('utf8').replace('| 12 | RA4', '| 12 | RA4, RA9');
    const rr = await A.extractAcademicContext([{ name: 'ref.txt', data: Buffer.from(txt) }]);
    assert(rr.notes.some((n) => n.code === 'UNKNOWN_OUTCOME_REF_IN_DOCUMENT' && /RA9/.test(n.message)), 'aviso del vínculo desconocido');
    eq(rr.context.units[3].outcomeIds, ['RA4'], 'vínculo desconocido descartado');
    eq(A.sniffMediaType(Buffer.from([0, 1, 2, 3, 0xff]), 'x.bin'), null, 'binario desconocido: no soportado');
  });

  await check('AC6 contexto → perfil pedagógico (con procedencia; enfoque del docente intacto)', () => {
    const fresh = A.suggestProfileFromContext(ctx, null);
    eq(fresh.changes.map((c) => [c.path, c.source]), [
      ['learner.description', 'found'], ['learner.educationLevel', 'inferred'], ['learningOutcomes.know', 'found'],
      ['learningOutcomes.do', 'found'], ['learningOutcomes.competencies', 'found'], ['targetHours', 'found'], ['assessmentMethods', 'found'],
    ], 'cambios sobre un perfil vacío (con su procedencia)');
    const current = profileOf('competencias'); // ya dice educationLevel 'technical': ese campo no cambia
    const s = A.suggestProfileFromContext(ctx, current);
    eq(s.changes.some((c) => c.path === 'learner.educationLevel'), false, 'un dato igual no se informa como cambio');
    eq(s.profile.primaryApproach, 'competencias', 'enfoque conservado');
    eq(s.profile.targetHours, 64, 'horas objetivo del documento');
    eq(s.profile.learningOutcomes.know.length + s.profile.learningOutcomes.do.length, 6, 'resultados repartidos saber / saber hacer');
    eq(s.profile.assessmentMethods, ['practical_exercises', 'cases', 'projects', 'products_evidence'], 'métodos de evaluación del documento');
    eq(s.approachHints, ['problemas'], 'pista: la metodología nombra ABP');
    eq(P.validatePedagogicalProfile(s.profile), [], 'perfil válido');
    const many = clone(ctx);
    many.outcomes = Array.from({ length: 15 }, (_v, i) => ({ id: `RA${i + 1}`, text: `Aplicar el procedimiento ${i + 1} del curso`, level: 'apply', domain: 'do', status: 'provided', sources: [] }));
    const s2 = A.suggestProfileFromContext(A.normalizeAcademicContext(many), null);
    eq(s2.profile.learningOutcomes.do.length, 12, 'tope del perfil');
    assert(s2.notes.some((n) => /admite 12/.test(n)), 'aviso del tope');
  });

  await check('AC7 contexto → estructura: unidades → módulos, contenidos → capítulos, objetivos = resultados', async () => {
    const p = A.proposeStructureFromContext(ctx);
    eq([p.available, p.counts], [true, { modules: 5, chapters: 18, linkedChapters: 18, inferredLinks: 1, outcomesCovered: 6, outcomesTotal: 6 }], 'propuesta');
    // Review M1: «Punto de equilibrio» toma solo RA5 de los dos de su unidad (elección por términos → inferred).
    eq([p.modules[4].chapters[1].outcomeIds, p.modules[4].chapters[1].linkStatus, p.modules[4].chapters[0].linkStatus], [['RA5'], 'inferred', 'found'], 'subconjunto por términos = inferido');
    eq(p.modules.map((m) => m.title), ctx.units.map((u) => u.title), 'módulos = unidades');
    eq(p.modules[1].objective, 'Calcular el costo de los materiales y de la mano de obra aplicando métodos de valoración de inventarios y la liquidación de la nómina.', 'objetivo del módulo = su resultado');
    eq(p.modules[4].outcomeIds, ['RA5', 'RA6'], 'vínculos del módulo');
    const titles = p.modules.flatMap((m) => m.chapters.map((c) => c.title));
    eq(titles.every((t) => t.length <= 80) && new Set(titles.map((t) => t.toLowerCase())).size === titles.length, true, 'títulos ≤ 80 y únicos');
    eq(p.modules[0].chapters.map((c) => c.outcomeIds), [['RA1'], ['RA1'], ['RA1'], ['RA1']], 'vínculos del documento por capítulo');
    eq(p.modules[0].chapters.every((c) => c.linkStatus === 'found' && c.objective === null), true, 'objetivo de capítulo no inventado');
    // > 5 contenidos en una unidad → 5 capítulos que listan todos sus contenidos.
    const big = clone(ctx);
    big.units[0].contents = Array.from({ length: 8 }, (_v, i) => ({ id: `U1.${i + 1}`, text: `Tema número ${i + 1} de la unidad`, outcomeIds: [], status: 'provided', sources: [] }));
    const pb = A.proposeStructureFromContext(A.normalizeAcademicContext(big));
    eq(pb.modules[0].chapters.length, 5, '≤ 5 capítulos');
    eq(pb.modules[0].chapters.flatMap((c) => c.sourceContentIds).length, 8, 'ningún contenido perdido');
    assert(/Tema número 2 de la unidad/.test(pb.modules[0].chapters[0].description), 'la descripción lista los contenidos del capítulo');
    const min = A.proposeStructureFromContext((await extract('minimal', 'txt')).context);
    eq([min.available, min.counts.modules, min.counts.chapters], [true, 1, 3], 'mínimo: un módulo');
    assert(min.notes.some((n) => /un solo módulo/.test(n)), 'nota del módulo único');
    eq(A.proposeStructureFromContext(A.emptyAcademicContext()).available, false, 'sin unidades no hay propuesta');
  });

  const prop = A.proposeStructureFromContext(ctx);
  const frozen = A.academicBlueprintContext(ctx);
  const { modules, chapters } = rowsFromProposal(prop);
  const snap = SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: frozen }), modules, chapters);

  await check('AC8 Blueprint v2: contexto y vínculos congelados solo cuando existen; vínculos rotos → error', () => {
    eq(SNAP.validateBlueprintSnapshotV2(snap), [], 'snapshot válido');
    eq(snap.course.academicContext.outcomes.map((o) => o.id), ['RA1', 'RA2', 'RA3', 'RA4', 'RA5', 'RA6'], 'resultados congelados');
    eq(snap.course.academicContext.contextSha256, A.academicContextSha256(ctx), 'huella del contexto guardado');
    eq(Object.keys(snap.course).slice(-1)[0], 'academicContext', 'clave en orden fijo');
    eq(snap.modules[4].chapters[0].outcomeIds, ['RA5', 'RA6'], 'vínculos del capítulo');
    eq(SNAP.snapshotSha256V2(SNAP.recanonicalizeBlueprintSnapshotV2(JSON.parse(JSON.stringify(snap)))), SNAP.snapshotSha256V2(snap), 'ida y vuelta canónica');
    // Sin contexto ni vínculos: ninguna clave nueva (sha de siempre).
    const plain = SNAP.buildBlueprintSnapshotV2(courseRef(), modules, chapters.map(({ outcome_ids, ...c }) => c));
    eq([plain.course.academicContext, plain.modules[0].chapters[0].outcomeIds], [undefined, undefined], 'sin claves nuevas');
    const noLinks = SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: null }), modules, chapters.map((c) => ({ ...c, outcome_ids: null })));
    eq(SNAP.snapshotSha256V2(noLinks), SNAP.snapshotSha256V2(plain), 'null = ausente');
    throwsRe(() => SNAP.buildBlueprintSnapshotV2(courseRef(), modules, chapters), /pero el curso no tiene contexto académico/, 'vínculos sin contexto');
    throwsRe(() => SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: frozen }), modules, chapters.map((c, i) => (i === 0 ? { ...c, outcome_ids: ['RA9'] } : c))), /RA9, que no existe/, 'vínculo a un resultado inexistente');
    throwsRe(() => SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: frozen }), modules, chapters.map((c, i) => (i === 0 ? { ...c, outcome_ids: ['RA1', 'RA1'] } : c))), /INVALID_INPUT/, 'vínculo repetido');
    eq(SNAP.validateBlueprintInputV2(courseRef({ academicContext: frozen }), modules, chapters.map((c, i) => (i === 0 ? { ...c, outcome_ids: ['RA9'] } : c))).map((e) => e.code), ['UNKNOWN_OUTCOME_REF'], 'validateBlueprintInputV2 (400 del lock)');
    const tampered = clone(snap); tampered.modules[0].chapters[0].outcomeIds = ['CO1', 'RA1'];
    assert(SNAP.validateBlueprintSnapshotV2(tampered).some((e) => e.code === 'INVALID_OUTCOME_IDS'), 'orden no canónico detectado');
    const t2 = clone(snap); t2.course.academicContext.outcomes[0].text += ' ';
    assert(SNAP.validateBlueprintSnapshotV2(t2).some((e) => e.code === 'INVALID_ACADEMIC_CONTEXT'), 'contexto no canónico detectado');
  });

  // Manifest (rulesVersion 3) del snapshot con contexto: los items de siempre (R25: el Manifest no cambia).
  const manifest = MB.buildGenerationManifestV3(snap, { courseId: 7001, blueprintId: 'bp', blueprintNumber: 1, blueprintSha256: SNAP.snapshotSha256V2(snap) }, { activityTypeRules: 2 });
  const item = (key) => manifest.items.find((i) => i.key === key);

  await check('AC9 brief del claim: resultados por item, ≤ 4000 caracteres; sin contexto, el brief de siempre', () => {
    eq(MB.validateGenerationManifestV3(manifest, snap, { courseId: 7001, blueprintId: 'bp', blueprintNumber: 1, blueprintSha256: SNAP.snapshotSha256V2(snap) }), [], 'Manifest v3 válido con contexto');
    const ch = snap.modules[1].chapters[0];
    eq(AB.itemOutcomeIds(snap, item(`content:${ch.id}`)), ['RA2'], 'content: los del capítulo');
    eq(AB.itemOutcomeIds(snap, item(`exam:${snap.modules[4].id}`)), ['RA5', 'RA6'], 'examen del módulo: unión');
    eq(AB.itemOutcomeIds(snap, item('final_exam:7001')), ['RA1', 'RA2', 'RA3', 'RA4', 'RA5', 'RA6'], 'examen final: todos');
    eq(AB.itemOutcomeIds(snap, item(`presentation:${ch.id}`)), [], 'presentación (Gamma): nada');
    const b = GD.buildItemPedagogyBrief({ item: item(`activity:${ch.id}`), snapshot: snap, activityTypeRules: 2 });
    assert(b && b.text.includes(GD.PEDAGOGY_PROMPT_MARKER) && b.text.includes(AB.ALIGNMENT_PROMPT_MARKER), 'brief sin diseño con los dos marcadores');
    assert(b.text.includes('RA2 (saber hacer · aplicar): Calcular el costo de los materiales'), b.text);
    assert(/evidencia observable/.test(b.text), 'indicación del generador de actividades');
    eq([b.engineVersion, b.outcomes, b.directives.length], [0, ['RA2'], 0], 'brief solo de alineación');
    const fe = GD.buildItemPedagogyBrief({ item: item('final_exam:7001'), snapshot: snap });
    assert(/al menos una pregunta/.test(fe.text) && fe.text.length <= GD.PEDAGOGY_BRIEF_TEXT_MAX, 'examen final');
    eq(GD.buildItemPedagogyBrief({ item: item(`presentation:${ch.id}`), snapshot: snap }), null, 'proveedor sin diseño: sin brief');
    // Con diseño pedagógico: los dos bloques y el tope.
    const dr = P.runPedagogyDryRun({ structure: snap, profile: { ...profileOf('competencias'), targetHours: 64 }, activityTypeRules: 2 });
    const pbp = dr.pedagogical.blueprint;
    assert(pbp.course.academicContext && pbp.course.pedagogy, 'el Blueprint pedagógico conserva el contexto');
    const pm = dr.pedagogical.manifest;
    const pi = pm.items.find((i) => i.key === `application_activity:${ch.id}`) || pm.items.find((i) => i.key === `activity:${ch.id}`);
    const pb = GD.buildItemPedagogyBrief({ item: pi, snapshot: pbp, activityTypeRules: 2 });
    assert(pb.directives.length > 0 && pb.text.includes(AB.ALIGNMENT_PROMPT_MARKER) && pb.text.length <= GD.PEDAGOGY_BRIEF_TEXT_MAX, 'diseño + alineación');
    // Sin contexto: el brief de siempre (byte a byte).
    const drPlain = P.runPedagogyDryRun({ structure: SNAP.buildBlueprintSnapshotV2(courseRef(), modules, chapters.map(({ outcome_ids, ...c }) => c)), profile: profileOf('competencias'), activityTypeRules: 2 });
    const pi2 = drPlain.pedagogical.manifest.items.find((i) => i.key === pi.key);
    const plainBrief = GD.buildItemPedagogyBrief({ item: pi2, snapshot: drPlain.pedagogical.blueprint, activityTypeRules: 2 });
    eq([plainBrief.text.includes(AB.ALIGNMENT_PROMPT_MARKER), plainBrief.outcomes], [false, undefined], 'sin contexto: sin bloque ni clave');
    assert(pb.text.startsWith(plainBrief.text), 'el bloque se agrega DESPUÉS del brief de siempre');
    // Muchos resultados largos: se acota sin cortar líneas.
    const longCtx = clone(frozen); longCtx.outcomes = Array.from({ length: 20 }, (_v, i) => ({ id: `RA${i + 1}`, text: `Aplicar ${'x'.repeat(380)} ${i}`, level: 'apply', domain: 'do' }));
    const longChapters = chapters.map((c, i) => (i === 0 ? { ...c, outcome_ids: ['RA1', 'RA2', 'RA3', 'RA4', 'RA5', 'RA6', 'RA7', 'RA8'] } : { ...c, outcome_ids: null }));
    const ls = SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: longCtx }), modules, longChapters);
    const lb = GD.buildItemPedagogyBrief({ item: { type: 'content', moduleId: ls.modules[0].id, chapterId: ls.modules[0].chapters[0].id }, snapshot: ls });
    assert(lb.text.length <= GD.PEDAGOGY_BRIEF_TEXT_MAX && lb.text.split('\n').every((l) => !l.endsWith('x x')), `tope (${lb.text.length})`);
  });

  await check('AC10 huellas (R26): un vínculo cambia actividades / aplicación / exámenes, nunca el content', () => {
    const withApp = SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: frozen }), modules, chapters.map((c) => ({ ...c, application_minutes: 60 })));
    const changedRows = chapters.map((c, i) => ({ ...c, application_minutes: 60, ...(i === 4 ? { outcome_ids: ['RA2', 'CO1'] } : {}) }));
    const changed = SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: frozen }), modules, changedRows);
    const a = FP.computeFingerprintsV3(withApp);
    const b = FP.computeFingerprintsV3(changed);
    const id = chapters[4].id;
    const mid = chapters[4].module_id;
    const fpOf = (fps, key, extra = {}) => FP.itemFingerprintV3(fps, key, { variant: 'h5p', videoIdentity: 'v1', ...extra });
    for (const t of ['content', 'presentation', 'video', 'audiobook_chapter']) eq(fpOf(a, `${t}:${id}`), fpOf(b, `${t}:${id}`), `${t} intacto`);
    for (const t of ['experience', 'activity', 'video_interactions', 'application_activity']) assert(fpOf(a, `${t}:${id}`) !== fpOf(b, `${t}:${id}`), `${t} cambia`);
    assert(fpOf(a, `exam:${mid}`) !== fpOf(b, `exam:${mid}`) && fpOf(a, 'final_exam:7001') !== fpOf(b, 'final_exam:7001'), 'exámenes cambian');
    const other = chapters[0].id;
    eq(fpOf(a, `activity:${other}`), fpOf(b, `activity:${other}`), 'otro capítulo intacto');
    // Cambiar el TEXTO de un resultado congelado: solo lo que lo recibe.
    const ctx2 = clone(frozen); ctx2.outcomes[0].text = 'Identificar y clasificar los elementos del costo.';
    const c2 = FP.computeFingerprintsV3(SNAP.buildBlueprintSnapshotV2(courseRef({ academicContext: ctx2 }), modules, chapters.map((c) => ({ ...c, application_minutes: 60 }))));
    assert(fpOf(a, `activity:${chapters[0].id}`) !== fpOf(c2, `activity:${chapters[0].id}`), 'RA1 cambia la actividad de su capítulo');
    eq(fpOf(a, `activity:${chapters[5].id}`), fpOf(c2, `activity:${chapters[5].id}`), 'RA1 no toca capítulos de otro resultado');
    // Sin contexto: sin capa de alineación.
    eq(FP.computeFingerprintsV3(SNAP.buildBlueprintSnapshotV2(courseRef(), modules, chapters.map(({ outcome_ids, ...c }) => c))).alignment, undefined, 'sin contexto, huellas de siempre');
  });

  await check('AC11 el contexto cambia el diseño real: 64 h, enfoque, Manifest válido y costo', () => {
    const sp = A.suggestProfileFromContext(ctx, null);
    const run = (approach) => P.runPedagogyDryRun({ structure: snap, profile: { ...sp.profile, primaryApproach: approach, secondaryApproaches: [] }, activityTypeRules: 2 });
    const d = run('problemas').distribution;
    eq([d.status, d.targetHours], ['within_tolerance', 64], '64 h alcanzadas con la estructura del microcurrículo');
    eq([d.counts.modules, d.counts.contentChapters], [5, 18], 'la estructura del documento');
    eq(d.materialized.manifestErrors, [], 'Manifest de la propuesta válido');
    assert(Number(d.materialized.providers.estimateUsd.expected) > 0, 'costo estimado');
    const s = run('significativo').distribution;
    assert(s.counts.practiceChapters < d.counts.practiceChapters && s.counts.contentChapters > d.counts.contentChapters, 'el enfoque cambia cómo crece (práctica vs. profundidad)');
    // Baseline (Loop 0): la estructura de ejemplo 3 × 3 NO alcanzaba 64 h.
    const gold = require('./fixtures/baseline/design-baseline-v1.json');
    eq(gold.scenarios['competencias:64h'].status, 'cannot_reach_target', 'baseline 3 × 3');
    // Review M11: el Blueprint materializado conserva el contexto congelado y los vínculos de los capítulos existentes.
    const mat = P.materializeDistribution(snap, d);
    eq(mat.course.academicContext, snap.course.academicContext, 'contexto congelado en el diseño materializado');
    eq(mat.modules.flatMap((m) => m.chapters).filter((c) => c.outcomeIds).length, 18, 'los 18 capítulos del documento conservan sus vínculos');
    assert(mat.modules.flatMap((m) => m.chapters).some((c) => c.kind === 'practice' && !c.outcomeIds), 'la práctica agregada no inventa vínculos');
  });

  await check('AC12 vínculos sugeridos para una estructura existente (sin pisar los del docente)', () => {
    const existing = [
      { id: 'c1', moduleId: 'm1', title: 'Punto de equilibrio', objective: null, description: null },
      { id: 'c2', moduleId: 'm1', title: 'Costeo por órdenes de producción', objective: 'Aplicar la hoja de costos por orden', description: null },
      { id: 'c3', moduleId: 'm1', title: 'Bienvenida al curso', objective: null, description: null },
      { id: 'c4', moduleId: 'm1', title: 'Producción equivalente', objective: null, description: null, outcomeIds: ['RA6'] },
    ];
    const s = A.suggestOutcomeLinks(ctx, existing);
    eq(s.map((x) => [x.chapterId, x.status, x.suggested]), [['c1', 'inferred', ['RA5']], ['c2', 'inferred', ['RA3']], ['c3', 'none', []], ['c4', 'keep', ['RA6']]], 'sugerencias');
  });

  await check('AC14 robustez (review I3, I4, I5, I7, M2, M3, M7, M13): nunca rechaza un documento legible ni inventa vínculos', async () => {
    const txt = (lines) => Buffer.from(lines.join('\n'), 'utf8');
    // I3: valores fuera de rango → missing + nota (no 400); conflictos largos entre documentos se acotan.
    const r1 = await A.extractAcademicContext([{ name: 'raro.txt', data: txt(['Asignatura: X', 'Resultados de aprendizaje', 'RA1. Aplicar algo.', 'Horas totales: 6000 horas', 'Créditos: 90', 'Evaluación', '- Parcial (RA1) 120 %']) }]);
    eq([r1.context.hours.total.status, r1.context.hours.credits.status, r1.context.evaluation[0].weightPct], ['missing', 'missing', null], 'fuera de rango queda faltante');
    eq(r1.notes.filter((n) => n.code === 'VALUE_OUT_OF_RANGE').length, 3, 'una nota por valor');
    const long = 'x'.repeat(300);
    const r2 = await A.extractAcademicContext([
      { name: 'a.txt', data: txt(['Asignatura: X', 'Descripción', `Primera versión ${long}`, 'Contenidos', '- Tema']) },
      { name: 'b.txt', data: txt(['Asignatura: X', 'Descripción', `Segunda versión ${long}`]) },
    ]);
    assert(r2.context.conflicts.some((k) => k.path === 'identity.description' && k.values.every((v) => v.value.length <= 200)), 'conflicto largo acotado');
    // I4: el mapa de ids por documento reescribe los vínculos de sus unidades y evaluación.
    const r3 = await A.extractAcademicContext([
      { name: 'a.txt', data: txt(['Resultados de aprendizaje', 'RA1. Identificar peligros.', 'RA2. Evaluar riesgos.']) },
      { name: 'b.txt', data: txt(['Resultados de aprendizaje', 'RA1. Redactar informes técnicos.', 'RA2. Identificar peligros.', 'Contenidos', 'Unidad 1: Informes (RA1)', '- Estructura del informe', 'Unidad 2: Peligros (RA2)', '- Inspección', 'Evaluación', '- Informe técnico (RA1) — 100 %']) },
    ]);
    const redactar = r3.context.outcomes.find((o) => /Redactar/.test(o.text)).id;
    const identificar = r3.context.outcomes.find((o) => /Identificar/.test(o.text)).id;
    eq([redactar, identificar], ['RA3', 'RA1'], 'ids fusionados');
    eq(r3.context.units.map((u) => u.outcomeIds), [[redactar], [identificar]], 'las unidades del 2.º documento apuntan al resultado correcto');
    eq(r3.context.evaluation[0].outcomeIds, [redactar], 'la evaluación también');
    // I5: en un PDF, una línea del cuerpo repetida en 2 páginas y el «64» bajo «Total de horas» se conservan.
    const PDFDocument = require('pdfkit');
    const pdf = await new Promise((res) => {
      const d = new PDFDocument({ info: { CreationDate: new Date(0) } });
      const ch = []; d.on('data', (x) => ch.push(x)); d.on('end', () => res(Buffer.concat(ch)));
      d.text('Encabezado institucional'); d.text('Contenidos'); d.text('Unidad 1: Bases'); d.text('- Taller práctico'); d.text('- Lectura guiada'); d.text('Pie común');
      d.addPage(); d.text('Encabezado institucional'); d.text('Unidad 2: Avance'); d.text('- Taller práctico'); d.text('- Caso'); d.text('Total de horas'); d.text('64'); d.text('Pie común');
      d.addPage(); d.text('Encabezado institucional'); d.text('Bibliografía'); d.text('- Autor, A. (2020). Libro.'); d.text('Pie común');
      d.end();
    });
    const r4 = await A.extractAcademicContext([{ name: 'p.pdf', data: pdf }]);
    eq(r4.context.units.map((u) => u.contents.map((c) => c.text)), [['Taller práctico', 'Lectura guiada'], ['Taller práctico', 'Caso']], 'contenidos repetidos entre páginas se conservan');
    eq([r4.context.hours.total.status, r4.context.hours.total.value], ['found', 64], 'el «64» del cuerpo se conserva');
    assert(r4.notes.some((n) => n.code === 'PAGE_FURNITURE_DROPPED'), 'nota de encabezados/pies descartados');
    assert(!r4.context.units.some((u) => u.contents.some((c) => /Encabezado|Pie común/.test(c.text))), 'encabezado y pie fuera');
    // M2: «CO2» en el texto no es una competencia; «(CE2)» sí.
    const r5 = await A.extractAcademicContext([{ name: 'c.txt', data: txt(['Competencias', 'CE1. Gestiona.', 'CE2. Controla.', 'Contenidos', 'Unidad 1: Ambiente', '- Emisiones de CO2 y efecto invernadero', '- Normas de control (CE2)']) }]);
    eq(r5.context.units[0].contents.map((c) => c.outcomeIds), [[], ['CO2']], 'CO2 de química ≠ competencia');
    // M3: «16 semanas de 4 horas» son semanas.
    const r6 = await A.extractAcademicContext([{ name: 's.txt', data: txt(['Asignatura: X', 'Semanas: 16 semanas de 4 horas', 'Contenidos', '- Tema']) }]);
    eq([r6.context.hours.weeks.value, r6.context.hours.total.status], [16, 'missing'], 'semanas, no total');
    // M13: TXT en Windows-1252 se lee (con nota).
    const r7 = await A.extractAcademicContext([{ name: 'w.txt', data: Buffer.from('Asignatura: Gestión de riesgos\nContenidos\n- Introducción\n', 'latin1') }]);
    eq(r7.context.identity.subjectName.value, 'Gestión de riesgos', 'tildes de Latin-1');
    assert(r7.notes.some((n) => n.code === 'ENCODING_ASSUMED_LATIN1'), 'nota de codificación');
    // M7: avisos acotados por código.
    const many = clone(ctx);
    many.outcomes = Array.from({ length: 30 }, (_v, i) => ({ id: `RA${i + 1}`, text: 'Aplicar el mismo procedimiento del curso', level: 'apply', domain: 'do', status: 'provided', sources: [] }));
    const v = A.validateAcademicContext(A.normalizeAcademicContext(many));
    const dup = v.issues.filter((i) => i.code === 'DUPLICATE_OUTCOME');
    assert(dup.length === 21 && /y \d+ aviso\(s\) más/.test(dup[20].message), `tope de avisos (${dup.length})`);
    // I7: DOCX cuyo XML descomprimido supera el tope → 400 claro, sin inflarlo.
    const JSZip = require('jszip');
    const z = new JSZip();
    z.file('word/document.xml', '<w:document><w:body>' + ' '.repeat(21 * 1024 * 1024) + '</w:body></w:document>');
    const bomb = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    let code = null;
    try { await A.extractAcademicContext([{ name: 'bomba.docx', data: bomb }]); } catch (e) { code = e.code; }
    eq([bomb.length < 1024 * 1024, code], [true, 'DOCUMENT_TOO_LARGE'], 'zip bomb rechazado');
  });

  await check('AC13 0 llamadas de red medidas', () => eq(netAttempts, [], 'intentos de red'));

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
