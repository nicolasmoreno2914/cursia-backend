#!/usr/bin/env node
/* eslint-disable */
// Loop 6 · Bloque 5: batería de calidad de un run terminado (pura). Un curso limpio pasa; cada defecto inyectado se
// detecta con su código; compareQualityReports bloquea una optimización que empeora una métrica.
// Usage: npm run build && node scripts/check-quality-battery.js [dist]
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const Q = require(path.join(distRoot, 'modules/quality/quality-battery.js'));

let passes = 0; let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const codes = (rep, id) => rep.checks.find((c) => c.id === id).findings.map((f) => f.code);
const get = (rep, id) => rep.checks.find((c) => c.id === id);

const PARA = (topic, extra) => `La ${topic} es una práctica de mantenimiento que el técnico aplica en planta para reducir fallas, con registros claros, inspección visual, medición de vibraciones y verificación de holguras antes de cada arranque del equipo ${extra}.`;
function course() {
  const ch = [
    { id: 'c1', moduleId: 'm1', title: 'Lubricación de rodamientos', outcomeIds: ['RA1'] },
    { id: 'c2', moduleId: 'm1', title: 'Alineación de ejes', outcomeIds: ['RA2'] },
    { id: 'c3', moduleId: 'm2', title: 'Sellos mecánicos', outcomeIds: ['RA2'] },
  ];
  return {
    chapters: ch,
    outcomes: [{ id: 'RA1', text: 'Aplicar la lubricación de rodamientos con el lubricante y la frecuencia correctos' }, { id: 'RA2', text: 'Verificar la alineación de ejes y el estado de sellos mecánicos' }],
    competencies: [{ id: 'CO1', text: 'Mantener bombas centrífugas de proceso' }],
    manifestItems: [
      { key: 'course_plan:c', type: 'course_plan' }, { key: 'course_intro:c', type: 'course_intro' },
      ...ch.map((c) => ({ key: `content:${c.id}`, type: 'content', chapterId: c.id, moduleId: c.moduleId })),
      { key: 'exam:m1', type: 'exam', moduleId: 'm1' },
    ],
    artifactTypesByItem: {
      'course_plan:c': ['dynamic_course_plan_json'], 'course_intro:c': ['dynamic_course_intro_json'],
      'content:c1': ['dynamic_content_md', 'dynamic_context_summary_json'], 'content:c2': ['dynamic_content_md', 'dynamic_context_summary_json'], 'content:c3': ['dynamic_content_md', 'dynamic_context_summary_json'],
      'exam:m1': ['dynamic_exam_bank_json'],
    },
    chapterMd: {
      c1: `# Lubricación de rodamientos\n\n${PARA('lubricación de rodamientos', 'usando el lubricante con la frecuencia que indica el fabricante')}\n\nEl lubricante correcto depende de la carga y la velocidad del rodamiento.`,
      c2: `# Alineación de ejes\n\n${PARA('alineación de ejes', 'con reloj comparador y láser, verificando la alineación angular y paralela')}\n\nUn eje desalineado acelera el desgaste del rodamiento lubricado.`,
      c3: `# Sellos mecánicos\n\nEl sello mecánico evita fugas del fluido de proceso; su estado se verifica midiendo la temperatura de las caras, revisando el goteo admisible, la presión de la cámara y la alineación de ejes que lo protege del desgaste prematuro durante la operación continua de la bomba centrífuga en la planta.`,
    },
    contextSummaries: {
      c1: { concepts_introduced: ['lubricación de rodamientos'], concepts_assumed: [], key_terms: ['lubricante', 'rodamiento'] },
      c2: { concepts_introduced: ['alineación de ejes'], concepts_assumed: ['lubricación de rodamientos'], key_terms: ['alineación', 'reloj comparador'] },
      c3: { concepts_introduced: ['sello mecánico'], concepts_assumed: ['alineación de ejes'], key_terms: ['sello mecánico', 'fugas'] },
    },
    introCompetencies: ['Mantener bombas centrífugas de proceso en planta', 'Diagnosticar fallas'],
    examBanks: { 'exam:m1': { chapterIds: ['c1', 'c2'], questions: [{ chapterId: 'c1', evidence: 'El lubricante correcto depende de la carga y la velocidad del rodamiento' }, { chapterId: 'c2', evidence: 'Un eje desalineado acelera el desgaste del rodamiento lubricado' }] } },
  };
}

check('curso limpio: todas las métricas en su mejor valor y el reporte pasa', () => {
  const r = Q.runQualityBattery(course());
  assert(r.version === 'quality-battery-v1', 'versión');
  for (const c of r.checks) assert(c.pass, `${c.id} no pasa: ${JSON.stringify(c.findings).slice(0, 300)}`);
  assert(r.summary.Q1 === 1 && r.summary.Q2 === 0 && r.summary.Q3 === 1 && r.summary.Q4 === 1 && r.summary.Q6 === 1 && r.summary.Q7 === 1, JSON.stringify(r.summary));
  assert(r.pass, 'pasa');
});
check('Q1: un item sin su artifact = contenido perdido (crítico)', () => {
  const c = course(); c.artifactTypesByItem['content:c2'] = ['dynamic_context_summary_json'];
  const r = Q.runQualityBattery(c);
  assert(!get(r, 'Q1').pass && codes(r, 'Q1').includes('Q1_MISSING_ARTIFACT') && !r.pass, 'Q1');
});
check('Q2: un párrafo copiado en otro capítulo se detecta', () => {
  const c = course(); c.chapterMd.c3 += `\n\n${PARA('lubricación de rodamientos', 'usando el lubricante con la frecuencia que indica el fabricante')}`;
  const r = Q.runQualityBattery(c);
  assert(codes(r, 'Q2').includes('Q2_DUPLICATE_PARAGRAPH') && r.summary.Q2 > 0, JSON.stringify(r.summary));
});
check('Q3: un término clave que el capítulo no usa se detecta', () => {
  const c = course(); c.contextSummaries.c1.key_terms.push('viscosidad cinemática');
  const r = Q.runQualityBattery(c);
  assert(codes(r, 'Q3').includes('Q3_KEY_TERM_ABSENT') && r.summary.Q3 < 1, JSON.stringify(r.summary));
});
check('Q4: un resultado que ningún capítulo vinculado refleja se detecta', () => {
  const c = course(); c.outcomes.push({ id: 'RA3', text: 'Calcular el NPSH disponible para prevenir la cavitación' }); c.chapters[2].outcomeIds.push('RA3');
  const r = Q.runQualityBattery(c);
  assert(codes(r, 'Q4').includes('Q4_OUTCOME_NOT_REFLECTED') && r.summary.Q4 < 1, JSON.stringify(r.summary));
});
check('Q5: competencias académicas ausentes de la bienvenida bajan la métrica', () => {
  const c = course(); c.introCompetencies = ['Redactar informes de auditoría financiera'];
  const r = Q.runQualityBattery(c);
  assert(r.summary.Q5 === 0 && codes(r, 'Q5').includes('Q5_COMPETENCY_NOT_IN_INTRO'), JSON.stringify(r.summary));
});
check('Q6: capítulo sin preguntas (crítico) y evidencia que no está en el capítulo', () => {
  const c = course(); c.examBanks['exam:m1'].questions = [{ chapterId: 'c1', evidence: 'Una frase inventada que el capítulo no dice' }];
  const r = Q.runQualityBattery(c);
  assert(codes(r, 'Q6').includes('Q6_CHAPTER_NOT_ASSESSED') && codes(r, 'Q6').includes('Q6_EVIDENCE_NOT_IN_CHAPTER') && !get(r, 'Q6').pass, 'Q6');
});
check('Q7: un concepto supuesto que nadie introdujo antes rompe la continuidad', () => {
  const c = course(); c.contextSummaries.c2.concepts_assumed = ['termografía infrarroja'];
  const r = Q.runQualityBattery(c);
  assert(codes(r, 'Q7').includes('Q7_ASSUMED_NOT_INTRODUCED') && r.summary.Q7 < 1, JSON.stringify(r.summary));
});
check('Q8: artifact de un item ajeno al Manifest (crítico) y capítulo sin resultado vinculado', () => {
  const c = course(); c.artifactTypesByItem['content:fantasma'] = ['dynamic_content_md']; c.chapters[1].outcomeIds = [];
  const r = Q.runQualityBattery(c);
  assert(codes(r, 'Q8').includes('Q8_ARTIFACT_WITHOUT_ITEM') && codes(r, 'Q8').includes('Q8_CHAPTER_WITHOUT_OUTCOME') && !get(r, 'Q8').pass, 'Q8');
});
check('sin contexto académico ni bancos: Q4/Q5/Q6/Q8 no aplican (null), sin falsos fallos', () => {
  const c = course(); c.outcomes = []; c.competencies = []; c.examBanks = {}; c.chapters.forEach((x) => { x.outcomeIds = []; });
  const r = Q.runQualityBattery(c);
  assert(r.summary.Q4 === null && r.summary.Q5 === null && r.summary.Q6 === null && r.summary.Q8 === null && r.pass, JSON.stringify(r.summary));
});
check('compareQualityReports: misma calidad ⇒ sin regresiones; métrica peor o check que deja de pasar ⇒ regresión', () => {
  const base = Q.runQualityBattery(course());
  assert(Q.compareQualityReports(base, Q.runQualityBattery(course())).length === 0, 'igual');
  const worse = course(); worse.contextSummaries.c1.key_terms.push('viscosidad cinemática', 'punto de goteo');
  const reg = Q.compareQualityReports(base, Q.runQualityBattery(worse));
  assert(reg.some((x) => x.id === 'Q3'), JSON.stringify(reg));
  const dup = course(); dup.chapterMd.c3 += `\n\n${PARA('lubricación de rodamientos', 'usando el lubricante con la frecuencia que indica el fabricante')}`;
  assert(Q.compareQualityReports(base, Q.runQualityBattery(dup)).some((x) => x.id === 'Q2'), 'Q2 más alto = peor');
});

console.log(`\n${passes} ok, ${failures} fail`);
process.exit(failures ? 1 : 0);
