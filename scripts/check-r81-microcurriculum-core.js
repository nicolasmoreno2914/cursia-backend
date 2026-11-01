#!/usr/bin/env node
/* eslint-disable */
// r81 · «Crear microcurrículo» — núcleo PURO contra el código COMPILADO en dist/ ("npm run build" antes). USD 0: sin
// red, sin DB, sin proveedores. Spec: validation/r81-microcurriculo/spec.md §1–§2, §4.1.
//
//   MC1  respuestas: normalización, 8 obligatorias, intensidad (horas / créditos × 48 / semanas × h), reparto, cortes
//   MC2  5 fixtures de institución (universidad, técnica, SENA/ETDH, colegio, corporativa): salida modelo → documento
//        → V1–V8 sin errores ni reparaciones → AcademicContextV1 válido (validateAcademicContextShape)
//   MC3  casos malos por cada código V1–V8 (cada uno detectado con su código)
//   MC4  reparación aritmética: V1 (proporcional a 0,5 h, respeta el reparto exigido) y V2 (mayor resto a 100), registrada
//   MC5  salida inservible → MicrocurriculumOutputError; edición del docente → procedencia `docente`; sección regenerada
//   MC6  prompt: herramienta forzada, restricciones calculadas, terminología por institución, reintento y regeneración,
//        español neutro (Language QA sin hallazgos)
//
// Uso: node scripts/check-r81-microcurriculum-core.js [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
const D = (rel) => {
  try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${e.message}`); process.exit(1); }
};
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const clone = (x) => JSON.parse(JSON.stringify(x));

const A = D('modules/microcurriculum/answers.js');
const DOC = D('modules/microcurriculum/document.js');
const V = D('modules/microcurriculum/validator.js');
const P = D('modules/microcurriculum/prompt.js');
const AC = D('modules/microcurriculum/to-academic-context.js');
const T = D('modules/microcurriculum/microcurriculum.types.js');
const ACX = D('modules/academic-context/academic-context.js');
const LQA = D('modules/language-qa/language-qa.js');

const FIX_DIR = path.join(REPO, 'scripts/fixtures/microcurriculum/r81');
const FIX = Object.fromEntries(['universidad', 'tecnica', 'etdh', 'colegio', 'corporativa'].map((k) => [k, JSON.parse(fs.readFileSync(path.join(FIX_DIR, `${k}.json`), 'utf8'))]));
/** Documento válido de un fixture (respuestas normalizadas + salida modelo). */
function docOf(k) {
  const answers = A.normalizeAnswers(FIX[k].answers);
  return { answers, mc: DOC.documentFromGenerated(clone(FIX[k].tool), answers) };
}
const codes = (issues, sev = 'error') => [...new Set(issues.filter((i) => i.severity === sev).map((i) => i.code))].sort();

(async () => {
  // ── MC1 respuestas ──
  await check('MC1.1 normalizeAnswers: colapsa espacios, descarta vacíos («Que Cursia lo proponga»), repetidos y lo desconocido; recorta a 2 000', () => {
    const n = A.normalizeAnswers({
      identification: { courseName: '  Finanzas   Corporativas ', institutionType: 'universidad', program: '', modality: 'hibrida', extra: 'x' },
      contents: { requiredTopics: ['Flujo de caja', ' flujo de caja ', '', 'VPN'], unitCount: 4.5 },
      learners: { profile: 'x'.repeat(2500) },
      time: { mode: 'total', totalHours: '120', split: { contact: 40, practice: -3 } },
      basura: { a: 1 },
    });
    eq(n.identification, { courseName: 'Finanzas Corporativas', institutionType: 'universidad' }, 'identificación');
    eq(n.contents, { requiredTopics: ['Flujo de caja', 'VPN'] }, 'temas sin repetidos; unitCount no entero descartado');
    eq(n.learners.profile.length, 2000, 'recorte a 2 000');
    eq(n.time, { mode: 'total', totalHours: 120, split: { contact: 40 } }, 'números en rango');
    assert(!('basura' in n), 'clave desconocida descartada');
  });
  await check('MC1.2 missingRequired: vacío → las 8 obligatorias (★) en orden estable; fixture completo → ninguna', () => {
    eq(A.missingRequired(A.normalizeAnswers({})), ['identification.courseName', 'identification.institutionType', 'learners.profile', 'purpose.need', 'purpose.expectedAbilities', 'time.totalHours', 'contents.requiredTopics', 'methodology.strategies']);
    for (const k of Object.keys(FIX)) eq(A.missingRequired(A.normalizeAnswers(FIX[k].answers)), [], k);
  });
  await check('MC1.3 resolveTotalHours: total, créditos × 48, semanas × h/semana; fuera de 1–1 000 → null', () => {
    eq(A.resolveTotalHours({ mode: 'total', totalHours: 96 }), 96);
    eq(A.resolveTotalHours({ mode: 'credits', credits: 3 }), 144);
    eq(A.resolveTotalHours({ mode: 'weekly', weeks: 16, hoursPerWeek: 4 }), 64);
    eq(A.resolveTotalHours({ mode: 'weekly', weeks: 16 }), null, 'semanas sin horas');
    eq(A.resolveTotalHours({ mode: 'credits', credits: 30 }), null, '1 440 h > 1 000');
    eq(A.resolveTotalHours({ totalHours: 40 }), 40, 'sin modo: primera forma completa');
  });
  await check('MC1.4 reparto imposible (suma > total, o los tres ≠ total) → falta «time.split»', () => {
    const base = A.normalizeAnswers(FIX.etdh.answers);
    eq(A.splitConsistent(base.time), true);
    const bad = clone(base); bad.time.split = { contact: 100, practice: 60 };
    eq(A.missingRequired(bad), ['time.split']);
    const bad3 = clone(base); bad3.time.split = { contact: 40, practice: 60, autonomous: 10 };
    eq(A.missingRequired(bad3), ['time.split']);
  });
  await check('MC1.5 parseInstitutionalCuts: «30/30/40», «20 / 30 / 50 %»; sin patrón o sin sumar 100 → null', () => {
    eq(A.parseInstitutionalCuts('Cortes 30/30/40 según el reglamento'), [30, 30, 40]);
    eq(A.parseInstitutionalCuts('20 / 30 / 50 %'), [20, 30, 50]);
    eq(A.parseInstitutionalCuts('Examen final obligatorio'), null);
    eq(A.parseInstitutionalCuts('fecha 12/05/2026'), null);
    eq(A.parseInstitutionalCuts(''), null);
  });

  // ── MC2 fixtures ──
  for (const k of Object.keys(FIX)) {
    await check(`MC2 fixture ${k}: documento → V1–V8 sin errores ni avisos, sin reparaciones; identificación literal; AcademicContextV1 válido`, () => {
      const { answers, mc } = docOf(k);
      const issues = V.validateMicrocurriculum(answers, mc);
      eq(issues, [], 'issues');
      const r = V.repairArithmetic(answers, mc);
      eq(r.repairs, [], 'sin reparaciones');
      eq(mc.identification.courseName, FIX[k].answers.identification.courseName, 'nombre literal');
      eq(mc.totalHours, A.resolveTotalHours(answers.time), 'total pedido');
      eq(mc.provenance.identification, 'docente', 'identificación del docente');
      eq(mc.provenance.outcomes, 'cursia', 'resultados de Cursia');
      const ctx = AC.toAcademicContext(mc, answers);
      eq(ACX.validateAcademicContextShape(ctx), [], 'forma del contexto');
      eq(ctx.identity.subjectName, { status: 'provided', value: FIX[k].answers.identification.courseName, sources: [] }, 'nombre provided');
      eq(ctx.outcomes[0].status, 'inferred', 'RA de Cursia → inferred');
      eq(ctx.outcomes[0].basis, 'cursia-microcurriculum', 'basis');
      eq(ctx.documents[0].extractor, { id: 'cursia-microcurriculum', version: 1 }, 'documento sintético');
      eq(ctx.hours.total.value, mc.totalHours, 'horas totales');
      eq(ctx.units.length, mc.units.length, 'unidades');
    });
  }
  await check('MC2.6 mapeo: bibliografía del docente → provided, sugerida → inferred; competencias del docente → provided; reparto exigido → provided', () => {
    const { answers, mc } = docOf('universidad');
    const ctx = AC.toAcademicContext(mc, answers);
    eq(ctx.bibliography.map((b) => b.status), ['provided', 'inferred']);
    eq(ctx.competencies.map((c) => c.status), ['provided', 'provided']);
    eq(ctx.hours.components.map((h) => [h.kind, h.hours, h.status]), [['contact', 48, 'provided'], ['autonomous', 96, 'provided']]);
    eq(ctx.hours.credits.value, 3, 'créditos');
    eq(ctx.identity.educationLevel.value.level, 'university', 'nivel');
    eq(ctx.outcomes.map((o) => o.level), ['remember', 'apply', 'apply', 'evaluate'], 'Bloom → BloomLevel');
  });

  // ── MC3 casos malos ──
  await check('MC3.V1 horas: unidades que no suman el total → V1; reparto exigido no respetado → V1', () => {
    const { answers, mc } = docOf('universidad');
    mc.units[0].hours.autonomous += 6;
    eq(codes(V.validateMicrocurriculum(answers, mc)), ['V1']);
    const e = docOf('etdh');
    e.mc.units[0].hours.practice -= 5; e.mc.units[0].hours.contact += 5; // suma intacta, reparto roto
    const iss = V.validateMicrocurriculum(e.answers, e.mc);
    eq(codes(iss), ['V1']);
    assert(iss.some((i) => /docente/.test(i.message)) && iss.some((i) => /práctica/.test(i.message)), 'nombra los tipos');
  });
  await check('MC3.V2 evaluación: Σ ≠ 100 → V2; cortes 30/30/40 en otro orden → V2 (suma 100)', () => {
    const { answers, mc } = docOf('universidad');
    mc.evaluation[3].percent = 30;
    eq(codes(V.validateMicrocurriculum(answers, mc)), ['V2']);
    const b = docOf('universidad');
    b.mc.evaluation = [b.mc.evaluation[3], b.mc.evaluation[0], b.mc.evaluation[1], b.mc.evaluation[2]];
    const iss = V.validateMicrocurriculum(b.answers, b.mc);
    eq(codes(iss), ['V2']);
    assert(/30\/30\/40/.test(iss[0].message), iss[0].message);
    eq(V.respectsCuts([15, 15, 30, 40], [30, 30, 40]), true);
    eq(V.respectsCuts([20, 15, 25, 40], [30, 30, 40]), false);
  });
  await check('MC3.V3 cobertura: RA sin evaluación → V3; unidad que referencia un RA inexistente → V3', () => {
    const { answers, mc } = docOf('tecnica');
    mc.evaluation[2].outcomeIds = ['RA1'];
    const iss = V.validateMicrocurriculum(answers, mc);
    eq(codes(iss), ['V3']);
    assert(iss.some((i) => /RA4 no se evalúa/.test(i.message)), JSON.stringify(iss));
    const b = docOf('tecnica');
    b.mc.units[0].outcomeIds.push('RA9');
    assert(V.validateMicrocurriculum(b.answers, b.mc).some((i) => i.code === 'V3' && /RA9, que no existe/.test(i.message)));
  });
  await check('MC3.V4 tema obligatorio ausente → V4 (con el tema); contención de tokens tolera tildes, plurales y orden', () => {
    const { answers, mc } = docOf('universidad');
    mc.units[3].contents = mc.units[3].contents.filter((c) => c !== 'Costo de capital');
    mc.units[3].title = 'Decisión de inversión';
    mc.units[3].contents.push('Costo promedio de la deuda');
    const iss = V.validateMicrocurriculum(answers, mc);
    eq(codes(iss), ['V4']);
    assert(/«Costo de capital»/.test(iss[0].message), iss[0].message);
    eq(V.topicAppears('Factores bióticos y abióticos', 'factor abiotico y factores BIOTICOS'), true, 'tildes/plurales/orden');
    eq(V.topicAppears('Redes neuronales', 'Redes de computadores'), false, 'contención total');
  });
  await check('MC3.V5 tema excluido presente → V5 (con la ubicación)', () => {
    const { answers, mc } = docOf('etdh');
    mc.units[2].contents.push('Facturación de servicios');
    const iss = V.validateMicrocurriculum(answers, mc);
    eq(codes(iss), ['V5']);
    eq(iss[0].path, 'units[2].contents[3]');
  });
  await check('MC3.V6 verbo no observable (comprender, «Conoce…», «El estudiante sabe…») → V6', () => {
    const { answers, mc } = docOf('universidad');
    mc.outcomes[0].verb = 'comprender';
    eq(codes(V.validateMicrocurriculum(answers, mc)), ['V6']);
    const b = docOf('colegio');
    b.mc.outcomes[1].verb = 'saber'; b.mc.outcomes[1].text = 'El estudiante sabe qué es una cadena alimentaria.';
    eq(codes(V.validateMicrocurriculum(b.answers, b.mc)), ['V6']);
    const c = docOf('corporativa');
    c.mc.outcomes[2].text = 'Conoce los objetivos del equipo para el trimestre.';
    eq(codes(V.validateMicrocurriculum(c.answers, c.mc)), ['V6'], 'primer verbo del enunciado');
  });
  await check('MC3.V7 literal: nombre cambiado, bibliografía obligatoria ausente o marcada como sugerida → V7', () => {
    const { answers, mc } = docOf('universidad');
    mc.identification.courseName = 'Finanzas corporativas';
    eq(codes(V.validateMicrocurriculum(answers, mc)), ['V7']);
    const b = docOf('universidad');
    b.mc.bibliography[0].text = b.mc.bibliography[0].text.replace('11.ª', '11a');
    assert(V.validateMicrocurriculum(b.answers, b.mc).some((i) => i.code === 'V7' && /Falta, literal/.test(i.message)));
    const c = docOf('colegio');
    c.mc.bibliography[0].origin = 'sugerida';
    assert(V.validateMicrocurriculum(c.answers, c.mc).some((i) => i.code === 'V7' && /figura como sugerida/.test(i.message)));
  });
  await check('MC3.V8 forma: 3 resultados, id repetido, Bloom inválido, unidades ≠ pedidas, competencias faltantes (universidad) → V8', () => {
    const { answers, mc } = docOf('universidad');
    mc.outcomes[1].id = 'RA1';
    mc.outcomes[2].bloom = 'memorizar';
    mc.competencies = [];
    const msgs = V.validateMicrocurriculum(answers, mc).filter((i) => i.code === 'V8').map((i) => i.message).join(' | ');
    assert(/Id repetido: RA1/.test(msgs) && /Bloom inválido/.test(msgs) && /Faltan las competencias/.test(msgs), msgs);
    const b = docOf('corporativa');
    b.mc.outcomes.pop();
    b.mc.units.pop();
    const m2 = V.validateMicrocurriculum(b.answers, b.mc).filter((i) => i.code === 'V8').map((i) => i.message).join(' | ');
    assert(/de 4 a 8 resultados/.test(m2) && /Se pidieron 3 unidades y hay 2/.test(m2), m2);
  });
  await check('MC3.V8b 2 unidades sin número pedido → aviso (no error); los errores van antes que los avisos', () => {
    const { answers, mc } = docOf('tecnica');
    mc.units[1].hours.contact += mc.units[2].hours.contact; mc.units[1].hours.practice += mc.units[2].hours.practice; mc.units[1].hours.autonomous += mc.units[2].hours.autonomous;
    mc.units[1].outcomeIds.push('RA4');
    mc.units.pop();
    mc.outcomes[0].verb = 'entender';
    const iss = V.validateMicrocurriculum(answers, mc);
    eq(iss.map((i) => [i.code, i.severity]), [['V6', 'error'], ['V8', 'warning']]);
  });

  // ── MC4 reparación aritmética ──
  await check('MC4.1 V1: horas desbalanceadas → redistribución proporcional a 0,5 h que suma el total y respeta el reparto exigido; registrada', () => {
    const { answers, mc } = docOf('universidad');
    mc.units.forEach((u) => { u.hours.contact = u.hours.contact * 1.3; u.hours.autonomous += 3.3; });
    assert(V.validateMicrocurriculum(answers, mc).some((i) => i.code === 'V1'), 'roto antes');
    const r = V.repairArithmetic(answers, mc);
    eq(V.validateMicrocurriculum(answers, r.mc).filter((i) => i.code === 'V1'), [], 'V1 resuelto');
    eq(r.mc.units.reduce((a, u) => a + u.hours.contact, 0), 48, 'docente exigido');
    eq(r.mc.units.reduce((a, u) => a + u.hours.autonomous, 0), 96, 'autónomo exigido');
    assert(r.mc.units.every((u) => [u.hours.contact, u.hours.practice, u.hours.autonomous].every((h) => Number.isInteger(h * 2))), 'múltiplos de 0,5');
    eq(r.repairs.length, 1, 'una reparación');
    assert(/Horas: se redistribuyeron .* 144 h/.test(r.repairs[0]) && /no respetaba el reparto exigido/.test(r.repairs[0]), r.repairs[0]);
    eq(r.mc.repairs, r.repairs, 'registrada en el documento');
    assert(mc.units[0].hours.contact !== r.mc.units[0].hours.contact, 'no muta la entrada... y sí cambia la salida');
  });
  await check('MC4.2 V1 sin reparto exigido: conserva la proporción por tipo del modelo (sin inventar horas de práctica)', () => {
    const { answers, mc } = docOf('colegio');
    mc.units.forEach((u) => { u.hours.contact *= 2; u.hours.practice *= 2; });
    const r = V.repairArithmetic(answers, mc);
    eq(r.mc.units.reduce((a, u) => a + u.hours.contact + u.hours.practice + u.hours.autonomous, 0), 40);
    eq(r.mc.units.map((u) => u.hours), [{ contact: 8, practice: 4, autonomous: 0 }, { contact: 8, practice: 6, autonomous: 0 }, { contact: 8, practice: 6, autonomous: 0 }], 'vuelve a la proporción');
  });
  await check('MC4.3 V2: Σ 90 % → escalado con mayor resto a enteros que suman 100; cortes que siguen rotos NO se «arreglan»', () => {
    const { answers, mc } = docOf('tecnica');
    mc.evaluation.forEach((e, i) => { e.percent = [25, 25, 40][i]; });
    const r = V.repairArithmetic(answers, mc);
    eq(r.mc.evaluation.map((e) => e.percent), [28, 28, 44]);
    eq(V.validateMicrocurriculum(answers, r.mc), [], 'válido');
    assert(/sumaban 90 %/.test(r.repairs[0]), r.repairs[0]);
    eq(V.largestRemainder([1, 1, 1], 100), [34, 33, 33], 'empates por orden');
    eq(V.largestRemainder([0, 0], 3), [2, 1], 'pesos nulos → partes iguales');
    const u = docOf('universidad');
    u.mc.evaluation = [u.mc.evaluation[3], u.mc.evaluation[0], u.mc.evaluation[1], u.mc.evaluation[2]];
    const r2 = V.repairArithmetic(u.answers, u.mc);
    eq(r2.repairs, [], 'cortes: no es aritmética');
    eq(codes(V.validateMicrocurriculum(u.answers, r2.mc)), ['V2']);
  });

  // ── MC5 documento ──
  await check('MC5.1 salida inservible (sin unidades / no objeto) → MicrocurriculumOutputError con los problemas', () => {
    const answers = A.normalizeAnswers(FIX.universidad.answers);
    const t = clone(FIX.universidad.tool); delete t.units;
    let err = null;
    try { DOC.documentFromGenerated(t, answers); } catch (e) { err = e; }
    assert(err instanceof DOC.MicrocurriculumOutputError && /units/.test(err.message), String(err));
    let err2 = null;
    try { DOC.documentFromGenerated('texto', answers); } catch (e) { err2 = e; }
    assert(err2 instanceof DOC.MicrocurriculumOutputError, 'no objeto');
  });
  await check('MC5.2 la identificación sale SIEMPRE del paso 1 (aunque el modelo la invente) y el total, de lo pedido', () => {
    const answers = A.normalizeAnswers(FIX.etdh.answers);
    const mc = DOC.documentFromGenerated({ ...clone(FIX.etdh.tool), identification: { courseName: 'Otro nombre' }, totalHours: 999 }, answers);
    eq(mc.identification.courseName, 'Atención al usuario en servicios de salud');
    eq(mc.totalHours, 120);
  });
  await check('MC5.3 edición del docente: campos cambiados → procedencia docente; lo demás intacto', () => {
    const { mc } = docOf('universidad');
    const edited = DOC.documentFromEdit({ ...clone(mc), description: 'Descripción escrita por la docente.', outcomes: clone(mc.outcomes) }, mc);
    eq(edited.provenance.description, 'docente');
    eq(edited.provenance.outcomes, 'cursia', 'sin cambios reales');
    eq(edited.provenance.units, 'cursia');
    let err = null;
    try { DOC.documentFromEdit([1, 2], mc); } catch (e) { err = e; }
    assert(err instanceof DOC.MicrocurriculumOutputError, 'no objeto → error');
  });
  await check('MC5.4 sección regenerada: reemplaza solo esa sección, procedencia cursia; sin la lista → error', () => {
    const { mc } = docOf('tecnica');
    const ev = [{ name: 'Única', percent: 100, outcomeIds: ['RA1', 'RA2', 'RA3', 'RA4'], week: 16, evidence: 'Proyecto integrador' }];
    const next = DOC.withRegeneratedSection({ ...mc, provenance: { ...mc.provenance, evaluation: 'docente' } }, 'evaluation', { evaluation: ev });
    eq(next.evaluation.length, 1);
    eq(next.units, mc.units, 'unidades intactas');
    eq(next.provenance.evaluation, 'cursia');
    let err = null;
    try { DOC.withRegeneratedSection(mc, 'units', { evaluation: ev }); } catch (e) { err = e; }
    assert(err instanceof DOC.MicrocurriculumOutputError, 'sin units');
  });

  // ── MC6 prompt ──
  await check('MC6.1 herramienta emit_microcurriculum: esquema estricto sin identificación ni procedencia (las pone el backend)', () => {
    const tool = P.microcurriculumTool();
    eq(tool.name, 'emit_microcurriculum');
    eq(tool.input_schema.additionalProperties, false);
    assert(!('identification' in tool.input_schema.properties) && !('provenance' in tool.input_schema.properties), 'campos del backend');
    eq(tool.input_schema.properties.outcomes.items.properties.bloom.enum, ['recordar', 'comprender', 'aplicar', 'analizar', 'evaluar', 'crear']);
    eq(P.sectionTool('units').input_schema.required, ['units']);
    eq(P.sectionTool('units').name, 'emit_microcurriculum');
  });
  await check('MC6.2 prompt del usuario: restricciones calculadas (144 h, reparto, 4 unidades, cortes), temas y bibliografía literal', () => {
    const answers = A.normalizeAnswers(FIX.universidad.answers);
    const u = P.buildUserPrompt(answers);
    for (const s of ['EXACTAMENTE 144 h', 'trabajo con el docente (contact) = 48 h', 'trabajo autónomo (autonomous) = 96 h', 'EXACTAMENTE 4', '30 / 30 / 40', '• Valor presente neto', '• Criptomonedas', FIX.universidad.answers.references.bibliography[0], 'Competencias: obligatorias']) {
      assert(u.includes(s), `falta «${s}»`);
    }
    const c = P.buildUserPrompt(A.normalizeAnswers(FIX.colegio.answers));
    assert(c.includes('Competencias: lista vacía'), 'colegio sin competencias');
  });
  await check('MC6.3 system: oficio + verbos prohibidos + terminología por institución (colegio «Desempeños», SENA «aprendices», corporativa «participantes»)', () => {
    const sys = (k) => P.buildSystemPrompt(A.normalizeAnswers(FIX[k].answers));
    assert(/diseñador curricular/.test(sys('universidad')) && /comprender, conocer, entender, saber/.test(sys('universidad')), 'oficio y verbos');
    assert(/NUNCA inventes ISBN, DOI, URL/.test(sys('universidad')), 'sin ISBN/URL inventados');
    assert(/«Desempeños»/.test(sys('colegio')) && /DESEMPEÑOS/.test(sys('colegio')), 'colegio');
    assert(/«aprendices»/.test(sys('etdh')), 'SENA');
    assert(/«participantes»/.test(sys('corporativa')), 'corporativa');
    eq(T.terminologyFor('colegio').outcomesLabel, 'Desempeños');
  });
  await check('MC6.4 reintento lleva la lista de errores; regenerar «outcomes» exige los MISMOS ids y manda el resto fijo', () => {
    const { answers, mc } = docOf('universidad');
    const issues = [{ code: 'V4', severity: 'error', message: 'El tema obligatorio «Costo de capital» no aparece en ninguna unidad.' }, { code: 'V8', severity: 'warning', message: 'aviso' }];
    const r = P.buildUserPrompt(answers, { issues });
    assert(r.includes('[V4] El tema obligatorio «Costo de capital»') && !r.includes('aviso'), 'solo errores');
    const g = P.buildRegeneratePrompt(answers, mc, 'outcomes', null);
    assert(g.includes('EXACTAMENTE 4 resultados con los MISMOS ids (RA1, RA2, RA3, RA4)'), 'ids');
    assert(g.includes('"units":[') && !g.includes('"outcomes":['), 'resto fijo sin la sección');
  });
  await check('MC6.5 español neutro: el system y la ficha no tienen hallazgos de Language QA (voseo, «vosotros», regionalismos)', () => {
    for (const k of Object.keys(FIX)) {
      const a = A.normalizeAnswers(FIX[k].answers);
      eq(LQA.lqaFindings(P.buildSystemPrompt(a)), [], `system ${k}`);
      eq(LQA.lqaFindings(P.buildUserPrompt(a)), [], `user ${k}`);
    }
  });

  console.log(`\n${ok} OK, ${fail} fallidas`);
  process.exit(fail ? 1 : 0);
})();
