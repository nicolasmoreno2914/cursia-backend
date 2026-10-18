#!/usr/bin/env node
/* eslint-disable no-console */
// r58 (I2 + I4) — informe de calidad del curso (formato común E4) y P1 de r57. USD 0: sin red, sin LLM, sin base (fakes).
//
//   QR1  formato común + tabla de severidades: adaptadores (validateMbzV3, avisos del empaque, rechazos de items, banco,
//        batería Q1–Q9, horas, diseño, alineación) → {code, severity, location, evidence, rule, cause, recommendation,
//        blocksDelivery, kind}; blocksDelivery ⇔ BLOCKER; orden estable
//   QR2  Q7 NOT MEASURED: sin sidecars / sin supuestos / todo externo → status not_measured, pass false, blocking false,
//        hallazgo Q7_NOT_MEASURED (INFO, measured:false); medido → igual que antes
//   QR3  cursos sintéticos LIMPIOS (conceptual, procedimental, protocolo, decisión, comunicación, normativo, mixto) → sin
//        BLOCKER ni MAJOR
//   QR4  defectos deliberados → hallazgos y severidades esperados: examen de memoria para competencia procedimental (MAJOR),
//        72 h vs 120 h (MAJOR, revisión humana), «siete» con 6 elementos (MINOR), aperturas repetidas (MINOR), vocabulario
//        interno (INFO reparado / MINOR conservado), sesgo de MC de video (MAJOR), remisión a una pregunta inexistente,
//        cierre prematuro (MINOR), puente repetido (INFO), actividad desproporcionada (MINOR), archivo nombrado y no adjunto
//        (MAJOR), gap de horas (MAJOR); con un hallazgo del validador → blocksDelivery
//   QR5  falsos positivos acotados: rangos y oraciones con dos cifras no se comparan; V/F falso no cuenta; misma parte no
//        cuenta; «dos veces» no es una lista
//   QR6  paquete real del fixture v3: el informe se arma sobre un .mbz válido (sin BLOCKER) y el resumen respeta el tope
//   B1   I4-1 sesgo de MC de video en el SERVIDOR al completar: señales del servidor (no las del ejecutor), rechazo
//        reintentable UNA vez (VIDEO_MC_COURSE_LENGTH_BIAS, clase B), luego aceptación blanda registrada; el fail cuenta el
//        rechazo en output_summary.answerBiasRecheck (clave del servidor); curso parejo / item que no empuja → acepta
//   P1   I4-2 archivo de trabajo al adjuntarlo: declaración + bytes (tamaño, sha256, firma) → 400 practice_file_invalid
//        claro; Storage ilegible → 503 practice_file_unverifiable; válido → checksum del servidor + practiceFileVerified;
//        otros tipos no se descargan; perfil: artifact ajeno / otro tipo / sha o tamaño distinto → PRACTICE_FILE_ATTACH_MISMATCH
//   P2   I4-3 claim de application_activity con los archivos de trabajo del capítulo (sin archivos = claim de siempre) y
//        prompt del ejecutor vendorizado que los nombra; el informe señala archivo nombrado y no adjunto
//   H1   I4-5 bienvenida con horas fraccionarias en coma decimal («40,5 h») y validador verde; enteras igual que antes
//
// Uso: node scripts/check-quality-report.js [dist]   (después de npm run build)
'use strict';
require('reflect-metadata');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const JSZip = require('jszip');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const QF = L('modules/quality/quality-finding.js');
const QR = L('modules/quality/course-quality-report.js');
const QC = L('modules/quality/course-quality-checks.js');
const QB = L('modules/quality/quality-battery.js');
const ALB = L('modules/quality/answer-length-bias.js');
const PFA = L('modules/artifacts/practice-file-attach.js');
const FC = L('modules/reliability/failure-classifier.js');
const { SchedulerService } = L('modules/dynamic-generation/scheduler.service.js');
const { ArtifactsService } = L('modules/artifacts/artifacts.service.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n   ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: ${x} !== ${y}`); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const codes = (r) => r.findings.map((f) => f.code);
const byCode = (r, c) => r.findings.filter((f) => f.code === c);

// ─── Fixtures sintéticas (genéricas: ningún cliente) ───────────────────────

const TYPES = {
  conceptual: { lt: 'conceptual', verb: 'Explicar', topic: 'los fundamentos de la gestión documental', level: 'understand', examLevel: 'comprender' },
  procedimental: { lt: 'procedimental', verb: 'Calcular', topic: 'el costo unitario de un producto', level: 'apply', examLevel: 'aplicar' },
  protocolo: { lt: 'protocolo', verb: 'Activar', topic: 'el protocolo de evacuación del edificio', level: 'apply', examLevel: 'aplicar' },
  decision: { lt: 'decision_caso', verb: 'Decidir', topic: 'la ruta ante un incidente de seguridad', level: 'evaluate', examLevel: 'analizar' },
  comunicacion: { lt: 'comunicacion', verb: 'Comunicar', topic: 'malas noticias a un cliente', level: 'apply', examLevel: 'aplicar' },
  normativo: { lt: 'normativo_etico', verb: 'Explicar', topic: 'el marco normativo de la protección de datos', level: 'understand', examLevel: 'comprender' },
};
const KINDS = Object.keys(TYPES);

function libroMd(t, i) {
  return [
    `# Capítulo ${i + 1}: ${t.topic}`,
    '',
    `Este capítulo trabaja ${t.topic} con ejemplos del trabajo diario de una organización de servicios.`,
    '',
    'Los tres pasos del método son:',
    '- Reunir la información disponible.',
    '- Aplicar el criterio del capítulo.',
    '- Registrar el resultado.',
    '',
    `## Ideas clave ${i + 1}`,
    '',
    'Cada caso se revisa con la persona responsable del proceso y se documenta en el sistema de la organización. Revisar dos veces el registro evita errores.',
  ].join('\n');
}
function experience(chId, i, opts = {}) {
  return {
    vcSchemaVersion: 1, chapterId: chId,
    movements: {
      opening: opts.openingNoQuestion ? [{ type: 'hero', title: 'Bienvenida al capítulo', text: 'Un recorrido por el tema.' }] : [{ type: 'hero', title: 'Pregunta inicial', text: `¿Qué harías primero en el caso ${i + 1}?` }],
      explanation: [{ type: 'concept_cards', title: 'Tres ideas clave', cards: [{ title: 'Uno', text: 'Primera idea.' }, { title: 'Dos', text: 'Segunda idea.' }, { title: 'Tres', text: 'Tercera idea.' }] }],
      closing: [{ type: 'text', text: opts.closing || `Con este capítulo tienes un método para el caso ${i + 1}. Lo usarás en el trabajo.` }],
    },
    bridge_to_next: opts.bridge || 'Ahora vas a usar lo aprendido en una situación nueva y más compleja del mismo proceso.',
  };
}
function question(id, chId, level, stem, explanation) {
  return { id, type: 'multichoice', chapterId: chId, level, stem: stem || `Pregunta ${id} sobre el capítulo y su método de trabajo`, explanation: explanation || 'La respuesta correcta sigue el método explicado en el capítulo con cada paso registrado.', evidence: 'Cada caso se revisa con la persona responsable', correct: { text: 'Opción correcta', why: 'Porque sigue el método.' }, distractors: [{ text: 'Opción incorrecta uno', why: 'No sigue el método.' }, { text: 'Opción incorrecta dos', why: 'No sigue el método.' }, { text: 'Opción incorrecta tres', why: 'No sigue el método.' }] };
}

/** Curso de 1 módulo × 3 capítulos; `kinds` = tipo por capítulo (mixto = varios). */
function makeCourse(name, kinds, opts = {}) {
  const M = `m-${name}`;
  const chs = kinds.map((k, i) => ({ id: `${name}-c${i + 1}`, k, t: TYPES[k] }));
  const manifest = {
    modules: [{ moduleId: M, chapters: chs.map((c, i) => ({ chapterId: c.id, chapterNumber: i + 1, ...(opts.applicationMinutes && opts.applicationMinutes[i] ? { applicationMinutes: opts.applicationMinutes[i] } : {}) })) }],
    items: chs.map((c) => ({ key: `activity:${c.id}`, type: 'activity', chapterId: c.id, moduleId: M, variant: 'h5p', h5pType: opts.h5pType || 'questionset' })),
  };
  const blueprint = {
    course: opts.outcomes ? { academicContext: { outcomes: opts.outcomes } } : {},
    modules: [{ id: M, chapters: chs.map((c, i) => ({ id: c.id, title: `${c.t.verb} ${c.t.topic}`, objective: `${c.t.verb} ${c.t.topic} en situaciones del trabajo`, ...(opts.outcomeIds ? { outcomeIds: opts.outcomeIds[i] } : {}), design: { learningType: { type: c.t.lt, level: c.t.level } } })) }],
  };
  const contentMd = new Map(chs.map((c, i) => [c.id, (opts.md && opts.md[i]) || libroMd(c.t, i)]));
  const experiences = new Map(chs.map((c, i) => [c.id, experience(c.id, i, (opts.exp && opts.exp[i]) || {})]));
  const levelOf = (c, j) => (opts.examLevels ? opts.examLevels : (j % 2 ? 'recordar' : c.t.examLevel));
  const questions = chs.flatMap((c, i) => [0, 1, 2].map((j) => question(`q${i}${j}`, c.id, levelOf(c, j), opts.stems && opts.stems[`q${i}${j}`], opts.explanations && opts.explanations[`q${i}${j}`])));
  return {
    manifest, blueprint,
    contents: {
      contentMd, experiences, videoInteractions: new Map(), applications: new Map(Object.entries(opts.applications || {})), guidedPractices: new Map(),
      examBanks: new Map([[M, { scope: 'module', moduleId: M, questions }]]), finalExamBank: null, examGift: new Map(), finalExamGift: null,
    },
    packageWarnings: opts.warnings || [],
    practiceResources: opts.practiceResources || [],
    hoursReport: opts.hoursReport || null,
    mbzIssues: opts.mbzIssues || null,
  };
}

const CLEAN = [
  ...KINDS.map((k) => [k, [k, k, k]]),
  ['mixto', ['conceptual', 'procedimental', 'decision']],
];

(async () => {
  await check('QR1 formato común + tabla de severidades (adaptadores; blocksDelivery ⇔ BLOCKER; orden estable)', () => {
    const shape = ['code', 'severity', 'layer', 'location', 'evidence', 'rule', 'cause', 'recommendation', 'blocksDelivery', 'kind'];
    const all = [
      ...QF.findingsFromMbzIssues([{ code: 'TOKEN_INVALID', where: 'cv3:shell:welcome', message: 'href="#"' }]),
      ...QF.findingsFromPackageWarnings(['internal_vocabulary_repaired:movimiento:3', 'internal_vocabulary_kept_length_limit:sidecar:1', 'formulaic_opening:reflection:piensa_en:11/15', 'video_mc_length_bias:29/55', 'libro_chars_unmapped:2', 'pending_video_omitted:video:c1', 'dead_link_unwrapped:1']),
      ...QF.findingsFromItemRejections([{ itemKey: 'experience:c1', final: true, errors: [{ path: '$.movements', code: 'PEDAGOGY_MISSING', message: 'falta el caso' }] }, { itemKey: 'exam:m1', final: false, errors: [{ code: 'EXAM_BANK_LENGTH_BIAS', message: 'x' }] }]),
      ...QF.findingsFromExamBankErrors('exam:m1', [{ path: '$.questions[0]', code: 'EXAM_BANK_EVIDENCE', message: 'evidencia ausente' }]),
      ...QF.findingsFromHoursReport({ reportVersion: 1, findings: [{ code: 'HOURS_TARGET_GAP', severity: 'MAJOR', detail: 'Faltan 4,5 h' }, { code: 'HOURS_UNMEASURED', severity: 'INFO', detail: '3 líneas' }] }),
      ...QF.findingsFromDesignVerification([{ id: 'hours', area: 'hours', severity: 'critical', title: 'Horas fuera' }, { id: 'ok', area: 'cost', severity: 'ok', title: 'bien' }, { id: 'g', area: 'practice', severity: 'warning', title: 'guiada > 30 %' }]),
      ...QF.findingsFromAlignment([{ id: 'a5-1', rule: 'A5', severity: 'warning', outcomeIds: ['RA1'], moduleIds: ['m1'], chapterIds: ['c1'], message: 'solo conceptual', suggestion: 'agregar AA', evidence: {} }, { id: 'a1', rule: 'A1', severity: 'critical', outcomeIds: ['RA2'], moduleIds: [], chapterIds: [], message: 'no cubierto', suggestion: 'x', evidence: {} }]),
    ];
    for (const f of all) for (const k of shape) assert(k in f, `${f.code}: falta ${k}`);
    for (const f of all) eq(f.blocksDelivery, f.severity === 'BLOCKER', `${f.code} blocksDelivery`);
    const sev = Object.fromEntries(all.map((f) => [`${f.code}|${f.rule.id}`, f.severity]));
    eq([sev['MBZ_VALIDATION|TOKEN_INVALID'], sev['INTERNAL_VOCABULARY_REPAIRED|internal_vocabulary_repaired'], sev['INTERNAL_VOCABULARY_KEPT|internal_vocabulary_kept_length_limit'], sev['FORMULAIC_OPENING|formulaic_opening'], sev['VIDEO_MC_LENGTH_BIAS|video_mc_length_bias']], ['BLOCKER', 'INFO', 'MINOR', 'MINOR', 'MAJOR'], 'empaque');
    eq([sev['ITEM_REJECTED_FINAL|PEDAGOGY_MISSING'], sev['ITEM_REJECTED_RETRIED|EXAM_BANK_LENGTH_BIAS'], sev['EXAM_BANK_INVALID|EXAM_BANK_EVIDENCE']], ['BLOCKER', 'INFO', 'BLOCKER'], 'items/banco');
    eq([sev['HOURS_TARGET_GAP|HOURS_TARGET_GAP'], sev['HOURS_UNMEASURED|HOURS_UNMEASURED'], sev['DESIGN_CRITICAL|hours'], sev['DESIGN_WARNING|g'], sev['A5|A5'], sev['A1|A1']], ['MAJOR', 'INFO', 'BLOCKER', 'MINOR', 'MAJOR', 'BLOCKER'], 'horas/diseño/alineación');
    assert(!all.some((f) => f.code.startsWith('PENDING')), 'avisos operativos sin mapeo se omiten');
    const r = QR.assembleCourseQualityReport([...all].reverse());
    eq(r.findings.map((f) => f.severity), [...r.findings.map((f) => f.severity)].sort((a, b) => ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'].indexOf(a) - ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'].indexOf(b)), 'orden por severidad');
    eq(JSON.stringify(QR.assembleCourseQualityReport(all)), JSON.stringify(r), 'mismo input en otro orden → mismo informe');
    assert(r.blocksDelivery && r.requiresHumanResolution && r.counts.BLOCKER === 5, JSON.stringify(r.counts));
    assert(all.every((f) => f.evidence.length <= QF.EVIDENCE_MAX), 'evidencia corta');
    const s = QR.courseQualityReportSummary(r, 3);
    eq([s.findings.length, s.truncated, s.counts], [3, r.findings.length - 3, r.counts], 'resumen con tope: contadores completos');
  });

  await check('QR2 Q7 NO MEDIDO nunca aprueba (sin sidecars / sin supuestos / todo externo) y se proyecta como INFO measured:false', () => {
    const chapters = [{ id: 'c1', moduleId: 'm', title: 'Uno' }, { id: 'c2', moduleId: 'm', title: 'Dos' }];
    const base = { chapters, outcomes: [], competencies: [], manifestItems: [], artifactTypesByItem: {}, chapterMd: { c1: 'texto uno', c2: 'texto dos' }, examBanks: {} };
    const q7 = (cs) => QB.runQualityBattery({ ...base, contextSummaries: cs }).checks.find((c) => c.id === 'Q7');
    for (const [cs, reason] of [[{}, 'no_sidecars'], [{ c1: { concepts_introduced: ['costo'], concepts_assumed: [] } }, 'no_assumed_concepts'], [{ c1: { concepts_introduced: ['costo'], concepts_assumed: ['álgebra lineal'] } }, 'all_assumed_external']]) {
      const c = q7(cs);
      eq([c.metric, c.pass, c.blocking, c.status, c.measuredReason], [null, false, false, 'not_measured', reason], `Q7 ${reason}`);
      assert(c.findings[0].code === 'Q7_NOT_MEASURED', 'hallazgo NOT_MEASURED primero');
    }
    const rep = QB.runQualityBattery({ ...base, contextSummaries: {} });
    assert(rep.pass === true, 'un check no medido no bloquea el reporte (blocking false)');
    const measured = q7({ c1: { concepts_introduced: ['costo unitario'], concepts_assumed: [] }, c2: { concepts_introduced: [], concepts_assumed: ['costo unitario'] } });
    eq([measured.metric, measured.pass, measured.status], [1, true, undefined], 'medido como siempre');
    const fs2 = QF.findingsFromQualityBattery(rep).filter((f) => f.code === 'Q7_NOT_MEASURED');
    eq([fs2.length, fs2[0].severity, fs2[0].measured], [1, 'INFO', false], 'proyección');
    assert(QR.assembleCourseQualityReport(fs2).notMeasured.includes('Q7_NOT_MEASURED'), 'notMeasured del informe');
  });

  await check('QR3 cursos LIMPIOS (conceptual, procedimental, protocolo, decisión, comunicación, normativo, mixto) → sin BLOCKER ni MAJOR', () => {
    for (const [name, kinds] of CLEAN) {
      const r = QR.buildPackageQualityReport(makeCourse(name, kinds));
      assert(r.counts.BLOCKER === 0 && r.counts.MAJOR === 0, `${name}: ${JSON.stringify(r.findings.filter((f) => f.severity === 'BLOCKER' || f.severity === 'MAJOR'))}`);
      assert(!r.blocksDelivery && !r.requiresHumanResolution, `${name}: entrega`);
      assert(r.counts.MINOR === 0, `${name}: MINOR inesperado ${JSON.stringify(r.findings.filter((f) => f.severity === 'MINOR'))}`);
    }
  });

  await check('QR4 defectos deliberados → hallazgos y severidades esperados (curso procedimental + extras)', () => {
    const SEVEN = ['# Capítulo 1', '', 'Los siete conceptos clave del costeo son:', '- Costo fijo.', '', '- Costo variable.', '- Costo directo.', '- Costo indirecto.', '- Costo unitario.', '- Margen.', '', 'La anticoncepción de emergencia es eficaz hasta 120 horas después de la relación.'].join('\n');
    const C2 = ['# Capítulo 2', '', 'La anticoncepción de emergencia solo funciona dentro de las primeras 72 h.', '', 'Has recorrido todo el curso y ya dominas el método.'].join('\n');
    const course = makeCourse('defectos', ['procedimental', 'procedimental', 'procedimental'], {
      md: [SEVEN, C2, null],
      examLevels: 'recordar',
      exp: [{ openingNoQuestion: true, closing: 'Vuelve a la pregunta del inicio y respóndela con el método.' }, { closing: 'El siguiente paso es aplicar el método completo en una situación nueva del mismo proceso de costos.', bridge: 'El siguiente paso es aplicar el método completo en una situación nueva del proceso.' }, {}],
      applicationMinutes: [120, null, null],
      applications: { 'defectos-c1': { title: 'Costeo', exercises: [{ id: 'E1', prompt: 'Abre plantilla_costos.xlsx y calcula el costo.' }] } },
      practiceResources: [{ id: 'datos', chapterId: 'defectos-c1', filename: 'datos-reales.csv', relation: 'application', title: 'Datos del taller' }],
      warnings: ['formulaic_opening:reflection:piensa_en:3/3', 'internal_vocabulary_repaired:movimiento:2', 'internal_vocabulary_kept_length_limit:sidecar:1', 'video_mc_length_bias:29/55'],
      hoursReport: { reportVersion: 1, findings: [{ code: 'HOURS_TARGET_GAP', severity: 'MAJOR', detail: 'Faltan 9,5 h para el objetivo de 40 h.' }], lines: [] },
    });
    const r = QR.buildPackageQualityReport(course);
    const want = {
      ASSESSMENT_MEMORY_FOR_PRACTICAL: ['MAJOR', 'needs_human_review', 2], // el cap. 1 tiene Actividad de Aplicación
      NUMERIC_WINDOW_CONFLICT: ['MAJOR', 'needs_human_review', 1],
      COUNT_CLAIM_MISMATCH: ['MINOR', 'deterministic', 1],
      FORMULAIC_OPENING: ['MINOR', 'deterministic', 1],
      INTERNAL_VOCABULARY_REPAIRED: ['INFO', 'deterministic', 1],
      INTERNAL_VOCABULARY_KEPT: ['MINOR', 'deterministic', 1],
      VIDEO_MC_LENGTH_BIAS: ['MAJOR', 'deterministic', 1],
      DANGLING_BACK_REFERENCE: ['MINOR', 'needs_human_review', 1],
      PREMATURE_COURSE_CLOSURE: ['MINOR', 'needs_human_review', 1],
      BRIDGE_DUPLICATE_DROPPED: ['INFO', 'deterministic', 1],
      ACTIVITY_LENGTH_DISPROPORTIONATE: ['MINOR', 'deterministic', 1],
      PRACTICE_FILE_REFERENCE_UNKNOWN: ['MAJOR', 'needs_human_review', 1],
      PRACTICE_FILE_NOT_REFERENCED: ['INFO', 'deterministic', 1],
      HOURS_TARGET_GAP: ['MAJOR', 'needs_human_review', 1],
    };
    for (const [code, [sev, kind, n]] of Object.entries(want)) {
      const fs = byCode(r, code);
      eq([fs.length, fs[0] && fs[0].severity, fs[0] && fs[0].kind], [n, sev, kind], code);
    }
    const nw = byCode(r, 'NUMERIC_WINDOW_CONFLICT')[0];
    assert(/72 h vs 120 h/.test(nw.evidence) && /antic emerg|emerg/.test(nw.evidence), `evidencia ventana: ${nw.evidence}`);
    assert(/anuncia 7 y la lista trae 6/.test(byCode(r, 'COUNT_CLAIM_MISMATCH')[0].cause), 'siete vs 6');
    assert(byCode(r, 'PREMATURE_COURSE_CLOSURE')[0].location.chapterId === 'defectos-c2', 'cierre prematuro en el cap. 2 (no el último)');
    assert(/plantilla_costos\.xlsx/.test(byCode(r, 'PRACTICE_FILE_REFERENCE_UNKNOWN')[0].evidence), 'archivo nombrado');
    assert(!r.blocksDelivery && r.requiresHumanResolution, 'MAJOR no bloquea solo; requiere resolución humana');
    const extra = Object.keys(want);
    const unexpected = r.findings.filter((f) => !extra.includes(f.code));
    eq(unexpected.map((f) => f.code), [], 'sin hallazgos fuera de lo esperado');
    // Con un hallazgo del validador del .mbz → BLOCKER y la entrega se bloquea.
    const rb = QR.buildPackageQualityReport({ ...course, mbzIssues: [{ code: 'STRUCTURE', where: 'cv3:x', message: 'falta' }] });
    assert(rb.blocksDelivery && rb.counts.BLOCKER === 1, 'BLOCKER bloquea');
    // Con resultados académicos: «saber hacer» evaluado solo de memoria → MAJOR por resultado.
    const ro = QR.buildPackageQualityReport(makeCourse('ra', ['conceptual', 'conceptual', 'conceptual'], { examLevels: 'recordar', outcomes: [{ id: 'RA1', text: 'Calcular el costo unitario', level: 'apply', domain: 'do' }, { id: 'RA2', text: 'Explicar el costo', level: 'understand', domain: 'know' }], outcomeIds: [['RA1'], ['RA2'], ['RA2']] }));
    const ma = byCode(ro, 'ASSESSMENT_MEMORY_FOR_PRACTICAL');
    eq([ma.length, /RA1/.test(ma[0].evidence)], [1, true], 'por resultado RA1 (saber hacer)');
    // Con una AA o preguntas de aplicación el mismo resultado ya no se señala.
    const ok = QR.buildPackageQualityReport(makeCourse('ra2', ['conceptual', 'conceptual', 'conceptual'], { examLevels: 'aplicar', outcomes: [{ id: 'RA1', text: 'Calcular el costo unitario', level: 'apply', domain: 'do' }], outcomeIds: [['RA1'], ['RA1'], ['RA1']] }));
    eq(byCode(ok, 'ASSESSMENT_MEMORY_FOR_PRACTICAL').length, 0, 'aplicar → sin hallazgo');
    const bs = QR.buildPackageQualityReport(makeCourse('bs', ['decision', 'decision', 'decision'], { examLevels: 'recordar', h5pType: 'branchingscenario' }));
    eq(byCode(bs, 'ASSESSMENT_MEMORY_FOR_PRACTICAL').length, 0, 'caso ramificado evalúa la decisión');
  });

  await check('QR5 falsos positivos acotados (rango, dos cifras, V/F falso, misma parte, «dos veces»)', () => {
    const W = (t, scope) => QC.windowMentions(t, { scope, section: 'libro' });
    eq(QC.numericWindowConflicts([...W('La profilaxis posexposición se inicia entre 72 y 120 horas.', 'a'), ...W('La profilaxis posexposición se ofrece hasta 120 horas.', 'b')]).length, 0, 'rango 72–120 = cota 120');
    eq(W('La anticoncepción de emergencia sirve 72 h con una pastilla y 120 h con otra.', 'a').length, 0, 'dos cifras en la oración: matizada');
    eq(QC.numericWindowConflicts([...W('La anticoncepción de emergencia sirve hasta 72 h.', 'a'), ...W('La anticoncepción de emergencia sirve hasta 120 h.', 'a')]).length, 0, 'misma parte del curso');
    eq(QC.numericWindowConflicts([...W('El reporte del incidente se entrega en 3 días.', 'a'), ...W('El reporte del incidente se entrega en 72 horas.', 'b')]).length, 0, '3 días = 72 h (unidades normalizadas)');
    const course = makeCourse('tf', ['conceptual', 'conceptual', 'conceptual'], { md: ['# Uno\n\nLa anticoncepción de emergencia es eficaz hasta 120 horas.', null, null] });
    course.contents.examBanks.get('m-tf').questions.push({ id: 'tf1', type: 'truefalse', chapterId: 'tf-c2', level: 'recordar', stem: 'La anticoncepción de emergencia es eficaz solo hasta 72 h.', answer: false, explanation: 'Falso: el capítulo explica otro plazo.', evidence: 'x', whyWrong: 'x' });
    eq(byCode(QR.buildPackageQualityReport(course), 'NUMERIC_WINDOW_CONFLICT').length, 0, 'V/F falso no cuenta');
    eq(QC.countClaimsInMarkdown('Revisar dos veces el registro:\n- a\n- b\n- c').length, 0, '«dos veces» no es una cifra de lista');
    eq(QC.countClaimsInMarkdown('## Los cuatro pasos\n\n### Paso uno\n\n### Paso dos\n\n### Paso tres\n\n### Paso cuatro').length, 0, 'encabezado con 4 subsecciones');
    eq(QC.countClaimsInMarkdown('## Los cinco pasos\n\n### Uno\n\n### Dos').map((c) => [c.claimed, c.found]), [[5, 2]], 'encabezado con 2 subsecciones');
    eq(QC.countClaimsInDoc({ title: 'Cuatro principios', cards: [1, 2, 3] }).map((c) => [c.claimed, c.found]), [[4, 3]], 'componente');
  });

  await check('QR6 paquete real del fixture v3: informe sobre un .mbz válido (sin BLOCKER), resumen con tope', async () => {
    const PF = require('./lib/v21-packaging-fixtures');
    const B = L('package/dynamic-mbz-builder-v3.js');
    const V = L('package/v3/mbz-validator-v3.js');
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 931 });
    const built = await B.buildDynamicMbzV3(input);
    const v = await V.validateMbzV3(built.mbz, built.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    const r = QR.buildPackageQualityReport({ manifest: input.manifest, blueprint: input.blueprint, contents: input.contents, packageWarnings: [...built.summary.warnings, ...built.summary.qualityWarnings], practiceResources: built.summary.practiceResources || null, hoursReport: built.expectations.facts.hoursReport || null, builderVersion: built.summary.builderVersion });
    eq(r.counts.BLOCKER, 0, 'sin BLOCKER en un paquete válido');
    assert(r.reportVersion === 1 && Array.isArray(r.findings), 'forma');
    const s = QR.courseQualityReportSummary(r, 1);
    assert(s.findings.length <= 1 && s.counts.INFO === r.counts.INFO, 'resumen');
    // El worker exporta el informe en el job y en la metadata del .mbz (reuse) — contrato de nombres.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/workers/dynamic-package-worker.ts'), 'utf8');
    assert(/qualityReport \? \{ qualityReport \} : \{\}/.test(src) && /existing\.metadata\?\.qualityReport/.test(src), 'worker: job + metadata + reuse');
  });

  await check('B1 sesgo de MC de video re-chequeado en el SERVIDOR al completar (un rechazo, luego blando; señales del servidor)', async () => {
    const mc = (correctLong) => ({ kind: 'multichoice', answers: [{ text: correctLong ? 'Una respuesta correcta claramente más larga que las demás' : 'Corta', correct: true }, { text: 'Otra opción', correct: false }, { text: 'Tercera op', correct: false }] });
    const doc = { checkpoints: [mc(true), mc(true), mc(true), { kind: 'truefalse', correct: true }] };
    const sig = ALB.videoMcSignals(doc);
    eq(sig.ranks.map((x) => [x.m, x.r, x.longest]), [[3, 2, true], [3, 2, true], [3, 2, true]], 'señales del servidor');
    eq(sig.tf, [true], 'V/F');
    const biasedPool = { v: 1, items: { 'video_interactions:x': { k: 'video_interactions', ranks: Array.from({ length: 12 }, () => ({ m: 3, r: 2 })), tf: [] } } };
    const evenPool = { v: 1, items: { 'video_interactions:x': { k: 'video_interactions', ranks: Array.from({ length: 12 }, (_, i) => ({ m: 3, r: i % 3 })), tf: [] } } };
    eq(ALB.videoMcCourseRecheck(doc, biasedPool, 0).action, 'reject', 'curso sesgado + item empuja → rechazo');
    eq(ALB.videoMcCourseRecheck(doc, biasedPool, 1).action, 'soft_accept', 'tras un rechazo → blando');
    eq(ALB.videoMcCourseRecheck(doc, evenPool, 0).action, 'accept', 'curso parejo');
    eq(ALB.videoMcCourseRecheck({ checkpoints: [mc(false), mc(false), mc(false)] }, biasedPool, 0).action, 'accept', 'item que no empuja');
    eq(ALB.videoMcCourseRecheck(doc, null, 0).action, 'accept', 'sin pool: 3 MC no alcanzan el mínimo');
    const c = FC.classifyFailure({ error: `v3_payload_invalid [${ALB.VIDEO_MC_COURSE_BIAS_CODE}]: x`, itemType: 'video_interactions', source: 'browser_executor' });
    assert(c && c.unclassified === false && c.class === 'B', `clase B explícita: ${JSON.stringify(c)}`);

    // prevalidateV3 con fakes (mismo patrón que check-ev6-h5p2-wire).
    const VF = require('./lib/v21-video-fixture');
    const H = L('package/h5p/index.js');
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const runId = '33333333-3333-4333-8333-333333333333';
    const chId = 'c1c1c1c1-0000-4000-8000-000000000001';
    const DUR = 468;
    const viItem = { key: `video_interactions:${chId}`, type: 'video_interactions', chapterId: chId, chapterNumber: 1 };
    const plan = H.planInteractionCheckpoints(DUR);
    const vdoc = VF.makeInteractionsDoc(plan, { videoItemKey: `video:${chId}`, durationSec: DUR });
    for (const cp of vdoc.checkpoints) if (cp.kind === 'multichoice') { const r = cp.answers.find((a) => a.correct); r.text = `${r.text} con una explicación adicional bastante más larga`; }
    const mkSvc = (pool, rejections) => {
      const svc = Object.create(SchedulerService.prototype);
      svc.dataSource = {
        async query(sql) {
          if (/output_summary -> 'answerBias' as answer_bias/.test(sql)) return pool ? Object.entries(pool.items).map(([k, s]) => ({ item_key: k, answer_bias: { signals: s } })) : [];
          if (/from public\.generation_item_runs d\b/.test(sql)) return [{ video_item_run_id: 'vrun', output_summary: { youtubeVideoId: 'IdwOipZAeqY', durationSec: DUR }, metadata: {} }];
          if (/from public\.generation_item_runs g\b/.test(sql)) return [{ id: runId, job_id: 'j', manifest_id: 1, item_key: viItem.key, type: 'video_interactions', status: 'running', worker_id: 'ex', chapter_id: chId, module_id: 'm', owner_id: OWNER, job_course_id: 1, frontend_course_id: 'fc', rules_version: 3, answer_bias_rejections: rejections, manifest_json: { rulesVersion: 3, features: { finalExam: false, activityEngine: 'h5p' }, items: [viItem] } }];
          if (/from public\.generation_run_contexts/.test(sql)) return [];
          if (/from public\.artifacts/.test(sql)) return [{ id: 'a1', type: 'dynamic_video_interactions_json', storage_bucket: 'b', storage_path: 'p' }];
          throw new Error(`query inesperada ${sql.slice(0, 60)}`);
        },
      };
      svc.v3Reader = { readText: async () => JSON.stringify(vdoc) };
      return svc;
    };
    const rej = await mkSvc(biasedPool, null).prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    eq([rej.kind, rej.codes, rej.retryable, rej.answerBiasRejection], ['invalid', [ALB.VIDEO_MC_COURSE_BIAS_CODE], true, true], 'rechazo reintentable');
    assert(/checkpoints\[\d+\]/.test(rej.message), `el mensaje dice qué corregir: ${rej.message}`);
    const soft = await mkSvc(biasedPool, '1').prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    eq([soft.kind, soft.summary.answerBiasCourse && soft.summary.answerBiasCourse.accepted], ['valid', 'soft'], 'tras el rechazo: aceptación blanda registrada');
    assert(soft.answerBiasSignals && soft.answerBiasSignals.k === 'video_interactions' && soft.answerBiasSignals.ranks.length === ALB.videoMcSignals(vdoc).ranks.length, 'señales del servidor para el acumulado');
    const okEven = await mkSvc(evenPool, null).prevalidateV3(runId, 'ex', ['a1'], OWNER, null);
    eq([okEven.kind, 'answerBiasCourse' in okEven.summary], ['valid', false], 'curso parejo: aceptado sin marca');
    // El fail cuenta el rechazo (clave del servidor; el ejecutor no la puede fijar).
    const S = L('modules/dynamic-generation/scheduler.service.js');
    assert(S.SERVER_OWNED_SUMMARY_KEYS.includes('answerBiasRecheck'), 'answerBiasRecheck es del servidor');
    const svc = Object.create(SchedulerService.prototype);
    svc.checkExecutorId = (x) => x;
    const queries = [];
    svc.guardedItemOp = async (_id, _ex, _o, _m, fn) => {
      const qr = { async query(sql, params) { queries.push({ sql, params }); if (/returning/.test(sql)) return [{ id: 'g1' }]; return []; } };
      try { await fn(qr, { id: 'j', owner_id: OWNER, worker_status: 'running' }, { id: 'g1', type: 'video_interactions', item_key: viItem.key, output_summary: {} }); } catch (e) { /* lo que sigue al contador no se prueba acá */ }
      return { ok: true };
    };
    await svc.failItemDetailed(runId, 'ex', rej.message, true, OWNER, { answerBiasRejection: true });
    const upd = queries.find((q) => /'answerBiasRecheck'/.test(q.sql));
    assert(upd && upd.params[0] === 'g1' && /\+ 1/.test(upd.sql), 'contador de rechazos persistido');
    queries.length = 0;
    await svc.failItemDetailed(runId, 'ex', 'otro error', true, OWNER, {});
    assert(!queries.some((q) => /'answerBiasRecheck'/.test(q.sql)), 'otros fallos no cuentan');
  });

  await check('P1 archivo de trabajo validado AL ADJUNTARLO (declaración + bytes) y al guardar el perfil', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const dto = (over) => ({ type: 'practice_file', storage_path: `${OWNER}/curso/practice_file/guia.pdf`, filename: 'guia.pdf', mime_type: 'application/pdf', size_bytes: pdf.length, checksum_sha256: sha256(pdf), metadata: { chapterId: 'c1' }, ...over });
    const mk = (bytes) => {
      const svc = Object.create(ArtifactsService.prototype);
      svc.downloads = 0;
      svc.downloadStorageObject = async () => { svc.downloads++; if (bytes instanceof Error) throw bytes; return bytes; };
      svc.saved = null;
      svc.artifactRepo = { create: (x) => x, save: async (x) => { svc.saved = x; return { id: 'art-1', ...x }; } };
      return svc;
    };
    const s1 = mk(pdf);
    await s1.createFromApi(dto(), OWNER);
    eq([s1.saved.checksumSha256, s1.saved.sizeBytes, s1.saved.metadata.practiceFileVerified], [sha256(pdf), pdf.length, { sha256: sha256(pdf), bytes: pdf.length, rules: 1 }], 'válido: checksum del servidor');
    const rejects = async (svc, d, status, code, re) => {
      try { await svc.createFromApi(d, OWNER); } catch (e) {
        const r = e.getResponse ? e.getResponse() : {};
        eq([e.getStatus(), r.code], [status, code], `${code}`);
        assert(re.test(r.message), `mensaje claro: ${r.message}`);
        return;
      }
      throw new Error('no rechazó');
    };
    await rejects(mk(pdf), dto({ filename: 'guia.exe', mime_type: 'application/octet-stream' }), 400, PFA.PRACTICE_FILE_INVALID_CODE, /extensión no permitida/);
    await rejects(mk(pdf), dto({ mime_type: 'text/plain' }), 400, PFA.PRACTICE_FILE_INVALID_CODE, /no corresponde a \.pdf/);
    await rejects(mk(pdf), dto({ size_bytes: 25 * 1024 * 1024 }), 400, PFA.PRACTICE_FILE_INVALID_CODE, /supera 20 MB/);
    await rejects(mk(pdf), dto({ checksum_sha256: null }), 400, PFA.PRACTICE_FILE_INVALID_CODE, /sha256/);
    const s2 = mk(pdf);
    await rejects(s2, dto({ filename: '../x.pdf' }), 400, PFA.PRACTICE_FILE_INVALID_CODE, /nombre de archivo inválido/);
    eq(s2.downloads, 0, 'declaración inválida: no se descarga');
    await rejects(mk(Buffer.concat([pdf, Buffer.from('x')])), dto(), 400, PFA.PRACTICE_FILE_INVALID_CODE, /bytes y se declararon|sha256 distinto/);
    const notPdf = Buffer.from('hola, esto no es un PDF de verdad.......');
    await rejects(mk(notPdf), dto({ size_bytes: notPdf.length, checksum_sha256: sha256(notPdf) }), 400, PFA.PRACTICE_FILE_INVALID_CODE, /no es un \.pdf válido/);
    await rejects(mk(new Error('timeout')), dto(), 503, PFA.PRACTICE_FILE_UNVERIFIABLE_CODE, /vuelve a adjuntarlo/);
    const s3 = mk(pdf);
    await s3.createFromApi({ type: 'dynamic_content_md', storage_path: `${OWNER}/c/x.md`, filename: 'x.md' }, OWNER);
    eq(s3.downloads, 0, 'otros tipos: sin descarga ni cambios');
    // Perfil.
    const res = [{ id: 'guia', source: { kind: 'artifact', artifactId: 'a-1', filename: 'guia.pdf', bytes: pdf.length, sha256: sha256(pdf) } }, { id: 'tabla', source: { kind: 'table', filename: 't.csv' } }];
    const row = { type: 'practice_file', size_bytes: String(pdf.length), checksum_sha256: sha256(pdf), filename: 'guia.pdf' };
    eq(PFA.practiceResourceAttachErrors(res, new Map([['a-1', row]])), [], 'coincide');
    const errs = (r) => PFA.practiceResourceAttachErrors(res, new Map([['a-1', r]])).map((e) => e.message);
    assert(/no existe o no es tuyo/.test(errs(null)[0]), 'ajeno / borrado');
    assert(/no es un archivo de trabajo/.test(errs({ ...row, type: 'dynamic_content_md' })[0]), 'otro tipo');
    assert(/sha256 distinto/.test(errs({ ...row, checksum_sha256: 'f'.repeat(64) })[0]), 'sha distinto');
    assert(/tamaño/.test(errs({ ...row, size_bytes: 3 })[0]), 'tamaño distinto');
    const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'src/modules/course-profiles/course-profiles.service.ts'), 'utf8');
    assert(/practiceResourceAttachErrors\(/.test(svcSrc) && /PRACTICE_FILE_ATTACH_MISMATCH_CODE/.test(svcSrc), 'el guardado del perfil usa el chequeo');
  });

  await check('P2 claim de la Actividad de Aplicación con los archivos de trabajo del capítulo + prompt vendorizado que los nombra', async () => {
    const svc = Object.create(SchedulerService.prototype);
    const manifest = { rulesVersion: 3, features: {}, modules: [{ moduleId: 'm', chapters: [{ chapterId: 'c1', applicationMinutes: 60 }] }], items: [] };
    const mItem = { key: 'application_activity:c1', type: 'application_activity', chapterId: 'c1', applicationMinutes: 60 };
    const profile = { practiceResources: [
      { id: 'datos', chapterId: 'c1', title: 'Datos de ventas', instructions: 'Usa la hoja Datos.', relation: 'application', source: { kind: 'table', format: 'xlsx', filename: 'ventas.xlsx' } },
      { id: 'otro', chapterId: 'c2', title: 'Otro capítulo', instructions: '', relation: 'chapter', source: { kind: 'artifact', filename: 'otro.pdf' } },
    ] };
    const qr = (data) => ({ async query(sql, params) { if (/from public\.course_profiles p join public\.production_jobs j/.test(sql)) { eq(params, ['job-1'], 'job'); return data ? [{ data }] : []; } throw new Error(`SQL no esperado ${sql.slice(0, 50)}`); } });
    const row = { type: 'application_activity', chapter_id: 'c1', job_id: 'job-1', item_key: mItem.key };
    const claim = await svc.buildClaimV3(qr(profile), row, mItem, manifest);
    eq(claim.application.practiceFiles, [{ title: 'Datos de ventas', filename: 'ventas.xlsx', instructions: 'Usa la hoja Datos.', relation: 'application' }], 'solo los del capítulo');
    const none = await svc.buildClaimV3(qr({ practiceResources: [] }), row, mItem, manifest);
    assert(!('practiceFiles' in none.application), 'sin archivos: claim de siempre');
    const noRun = await svc.buildClaimV3(qr(null), { ...row, job_id: undefined }, mItem, manifest);
    assert(!('practiceFiles' in noRun.application), 'sin run: no consulta');
    // Prompt del ejecutor vendorizado (el mismo que corre el worker de IA).
    const ctx = { console: { log() {}, warn() {}, error() {} } };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'vendor/dynamic-executor/44-dynamic-prompt-builders.js'), 'utf8'), ctx);
    const base = { minutes: 60, chapterKind: 'content', context: null };
    const p0 = ctx.dynApplicationActivityPrompt({ tono: 'x' }, [], { title: 'Cap' }, 'texto', base, '');
    const p1 = ctx.dynApplicationActivityPrompt({ tono: 'x' }, [], { title: 'Cap' }, 'texto', { ...base, practiceFiles: claim.application.practiceFiles }, '');
    assert(!/ARCHIVOS DE TRABAJO ADJUNTOS/.test(p0), 'sin archivos: prompt de siempre');
    assert(/ARCHIVOS DE TRABAJO ADJUNTOS/.test(p1) && /«Datos de ventas» \(archivo ventas\.xlsx\)/.test(p1) && /No menciones otros archivos/.test(p1), 'prompt con la lista');
    eq(p1.replace(ctx._dynApplicationPracticeFilesBlock({ ...base, practiceFiles: claim.application.practiceFiles }), ''), p0, 'solo agrega el bloque');
    // Empaque: la actividad que nombra el archivo adjunto no genera hallazgos; nombrar otro → MAJOR.
    const course = makeCourse('pf', ['procedimental', 'procedimental', 'procedimental'], { applicationMinutes: [60, null, null], applications: { 'pf-c1': { title: 'Ventas', exercises: [{ id: 'E1', prompt: 'Abre ventas.xlsx («Datos de ventas») y calcula el total de cada mes con las fórmulas del capítulo. Explica cada paso del cálculo, revisa los resultados con tu compañero y registra las diferencias encontradas en el informe del taller para la siguiente sesión de trabajo con el equipo.' }], workshop: { situation: 'La tienda necesita el informe mensual de ventas para decidir el inventario del próximo trimestre y cada vendedor debe revisar los datos de su zona.', instructions: ['Calcula los totales.', 'Compara los meses.', 'Propón una acción.'] } } }, practiceResources: [{ id: 'datos', chapterId: 'pf-c1', filename: 'ventas.xlsx', relation: 'application', title: 'Datos de ventas' }] });
    const r = QR.buildPackageQualityReport(course);
    eq(r.findings.filter((f) => f.code.startsWith('PRACTICE_FILE')).map((f) => f.code), [], 'archivo nombrado correctamente');
  });

  await check('H1 horas fraccionarias en coma decimal en la bienvenida («40,5 h») con el validador verde; enteras como antes', async () => {
    const PF = require('./lib/v21-packaging-fixtures');
    const B = L('package/dynamic-mbz-builder-v3.js');
    const V = L('package/v3/mbz-validator-v3.js');
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 932 });
    const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const welcomeOf = async (mbz) => {
      const z = await JSZip.loadAsync(mbz);
      for (const f of Object.keys(z.files).filter((n) => /^activities\/label_\d+\/label\.xml$/.test(n))) {
        const x = await z.file(f).async('string');
        if (/cvc-welcome-band/.test(unxml(x))) return unxml((x.match(/<intro>([\s\S]*?)<\/intro>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      }
      return '';
    };
    const frac = await B.buildDynamicMbzV3({ ...input, hours: 40.5 });
    assert((await welcomeOf(frac.mbz)).includes('Duración estimada: 40,5 h (definida por la institución).'), 'coma decimal');
    const v = await V.validateMbzV3(frac.mbz, frac.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 3)));
    const whole = await B.buildDynamicMbzV3({ ...input, hours: 40 });
    assert((await welcomeOf(whole.mbz)).includes('Duración estimada: 40 h (definida por la institución).'), 'entera igual');
  });

  console.log(`\n${passed} ok, ${failed} con fallas`);
  process.exit(failed ? 1 : 0);
})();
