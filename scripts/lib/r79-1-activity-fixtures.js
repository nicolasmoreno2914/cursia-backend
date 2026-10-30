/* eslint-disable */
// r79.1 — documentos SINTÉTICOS de los tipos nuevos de Actividad de Aplicación (estudio de caso, proyecto integrador,
// retroalimentación formativa) y de la Actividad de siempre v2 (nivel de 120 reforzado). Sin IA, sin red, USD 0.
// Deterministas; con las cantidades MÍNIMAS o MÁXIMAS del nivel (`o.size = 'min' | 'max'`) para probar los bordes.
'use strict';

const pick = (range, size) => (size === 'max' ? range[1] : range[0]);
const sent = (seed, words) => {
  const A = ['La coordinadora', 'El equipo de servicio', 'La persona usuaria', 'El supervisor de turno', 'La analista de calidad', 'El asesor de primera línea'];
  const B = ['revisa los registros del mes', 'escucha el reclamo completo', 'compara los tiempos de respuesta', 'identifica la causa del retraso', 'propone un ajuste al protocolo', 'documenta el acuerdo con el cliente'];
  const C = ['antes de la reunión semanal', 'con datos del sistema de turnos', 'sin culpar a otras áreas', 'dentro del plazo acordado', 'con un lenguaje claro', 'para evitar nuevos reprocesos'];
  const out = [];
  let n = 0;
  let i = seed;
  while (n < words) {
    const s = `${A[i % 6]} ${B[(i * 7 + 3) % 6]} ${C[(i * 5 + 1) % 6]} en la sede ${(i % 9) + 1}.`;
    out.push(s);
    n += s.split(/\s+/).length;
    i++;
  }
  return out.join(' ');
};
const chars = (seed, n) => {
  let s = sent(seed, Math.ceil(n / 6));
  while (s.length < n) s += ' ' + sent(seed + s.length, 20);
  return s.slice(0, Math.max(n, 1)).replace(/\s+\S*$/, '.') + '';
};
const textLen = (seed, n) => {
  // texto de al menos n caracteres
  let s = sent(seed, Math.ceil(n / 5) + 4);
  return s.length >= n ? s : s + ' ' + sent(seed + 3, Math.ceil(n / 4));
};

function criteria(n) {
  const names = ['Análisis de la situación', 'Uso de los conceptos del capítulo', 'Calidad de la propuesta', 'Comunicación escrita', 'Coherencia con los datos'];
  const w = { 3: [40, 35, 25], 4: [30, 30, 25, 15], 5: [25, 25, 20, 15, 15] }[n];
  return names.slice(0, n).map((name, i) => ({ name, description: `Se evalúa ${name.toLowerCase()} con evidencia concreta del trabajo.`, weight: w[i] }));
}
const correction = (crit) => crit.map((c) => ({ criterion: c.name, achieved: `Logrado: ${c.name.toLowerCase()} completo y correcto.`, developing: `En proceso: ${c.name.toLowerCase()} parcial o con errores.`, insufficient: `Insuficiente: no se observa ${c.name.toLowerCase()}.` }));
const outcomeLinks = (ids, n) => Array.from({ length: n }, (_, i) => ({ outcomeId: ids[i % ids.length], evidence: `La sección ${i + 1} del producto muestra este resultado con un caso concreto.` })).filter((x, i, xs) => xs.findIndex((y) => y.outcomeId === x.outcomeId) === i);

/** Estudio de caso (60 o 90 min). */
function caseStudyDoc(chapterId, minutes, n, o = {}) {
  const size = o.size || 'min';
  const C = { 60: { narrative: [900, 3200], exhibits: [1, 2], questions: [4, 5], constraints: [2, 3], alternatives: [1, 3], keyPoints: [2, 5], selfCheck: [4, 6], criteria: [3, 4], discussion: [2, 4] },
    90: { narrative: [1400, 4500], exhibits: [2, 3], questions: [6, 7], constraints: [3, 4], alternatives: [2, 3], keyPoints: [2, 5], selfCheck: [5, 8], criteria: [4, 4], discussion: [3, 5] } }[minutes];
  const ids = o.outcomeIds && o.outcomeIds.length ? o.outcomeIds : ['OBJ'];
  const nq = pick(C.questions, size);
  const levels = ['comprender', 'analizar', 'analizar', 'evaluar', 'evaluar', 'proponer', 'proponer'];
  const crit = criteria(pick(C.criteria, size));
  const narrative = (() => { const want = size === 'max' ? C.narrative[1] - 500 : C.narrative[0] + 120; const p1 = textLen(n * 11, Math.floor(want / 2)); const p2 = textLen(n * 13 + 5, want - p1.length); return `${p1}\n\n${p2}`; })();
  const split = minutes === 60 ? { reading: 12, analysis: 26, decision: 16, selfCheck: 6 } : { reading: 18, analysis: 38, decision: 26, selfCheck: 8 };
  const activity = {
    title: `Estudio de caso del capítulo ${n}: la sede que no cumplía los plazos`,
    objective: 'Analizar un caso real de atención al cliente y decidir un plan de mejora justificado con los conceptos del capítulo.',
    outcomeLinks: outcomeLinks(ids, Math.min(ids.length, 3)),
    deliverable: { description: 'Un informe breve con el análisis de cada pregunta y la decisión justificada.', format: 'Informe escrito', extent: minutes === 60 ? 'Dos páginas' : 'Tres páginas' },
    selfCheck: Array.from({ length: pick(C.selfCheck, size) }, (_, i) => `¿Mi análisis ${i + 1} usa datos del caso y no suposiciones?`),
    criteria: crit,
    case: {
      title: 'Plazos incumplidos en la sede norte',
      organization: 'Servicios Integrales del Valle (organización ficticia)',
      narrative,
      exhibits: Array.from({ length: pick(C.exhibits, size) }, (_, i) => ({ title: `Registro de tiempos ${i + 1}`, kind: ['table', 'data', 'testimony'][i % 3], content: `Semana 1: 42 casos, 31 dentro del plazo.\nSemana 2: 38 casos, 24 dentro del plazo.\nSemana 3: 45 casos, 27 dentro del plazo (anexo ${i + 1}).` })),
    },
    questions: Array.from({ length: nq }, (_, i) => ({ id: `Q${i + 1}`, prompt: `Con los datos del caso, ${['explica qué indica el registro de tiempos', 'compara las semanas y encuentra el patrón', 'identifica la causa más probable del retraso', 'evalúa si la medida actual del supervisor funciona', 'valora el riesgo de no actuar este mes', 'propón un ajuste al protocolo con su justificación', 'propón cómo medir el efecto del ajuste'][i]}.`, level: levels[Math.min(i, 6)], answerLines: 4 })),
    decision: { prompt: 'Decide qué cambio aplicarías primero en la sede norte y justifica por qué es mejor que las otras opciones.', constraints: Array.from({ length: pick(C.constraints, size) }, (_, i) => `Restricción ${i + 1}: sin contratar personal nuevo este trimestre.`.replace('Restricción 2: sin contratar personal nuevo este trimestre.', 'Restricción 2: el cambio debe medirse en cuatro semanas.').replace('Restricción 3: sin contratar personal nuevo este trimestre.', 'Restricción 3: respetar la política de datos personales.').replace('Restricción 4: sin contratar personal nuevo este trimestre.', 'Restricción 4: informar al cliente cada cambio de plazo.')) },
    minutesBySection: split,
  };
  activity.questions = activity.questions.slice(0, nq);
  const solution = {
    questionGuides: activity.questions.map((q) => ({ questionId: q.id, expectedAnalysis: `Un buen análisis de ${q.id} usa las cifras del anexo, muestra la caída de cumplimiento y la relaciona con el capítulo.`, keyPoints: Array.from({ length: pick(C.keyPoints, size) }, (_, i) => `Punto clave ${i + 1} de ${q.id}`) })),
    decisionDiscussion: { recommended: 'Reorganizar los turnos de la franja de mayor demanda y medir el cumplimiento semanal.', alternatives: Array.from({ length: pick(C.alternatives, size) }, (_, i) => `Alternativa aceptable ${i + 1}: priorizar los casos urgentes con una cola separada.`), justification: 'Es la opción que respeta las restricciones, ataca la causa observada en los anexos y se puede medir en cuatro semanas.' },
    discussionQuestions: Array.from({ length: pick(C.discussion, size) }, (_, i) => `¿Qué pasaría si la causa ${i + 1} fuera otra? Discútelo con el grupo.`),
    correctionGuide: correction(crit),
    teacherNotes: ['Acepta decisiones distintas si están justificadas con los datos del caso.'],
  };
  return { schemaVersion: 2, chapterId, minutes, kind: 'case_study', activity, solution };
}

/** Proyecto integrador (90 o 120 min). */
function projectDoc(chapterId, minutes, n, o = {}) {
  const size = o.size || 'min';
  const C = { 90: { stages: 3, stageTasks: [2, 4], integration: [2, 4], selfCheck: [5, 8], criteria: [4, 4], outcomeLinks: [2, 4], stageErrors: [1, 4], checkpoints: [1, 3] },
    120: { stages: 4, stageTasks: [2, 5], integration: [3, 5], selfCheck: [5, 8], criteria: [4, 5], outcomeLinks: [2, 4], stageErrors: [1, 4], checkpoints: [1, 3] } }[minutes];
  const ids = o.outcomeIds && o.outcomeIds.length ? o.outcomeIds : ['OBJ'];
  const crit = criteria(pick(C.criteria, size));
  const stageMin = minutes === 90 ? [22, 22, 21] : [22, 22, 21, 20];
  const titles = o.chapterTitles || ['Diagnóstico del servicio', 'Diseño del protocolo', 'Prueba con casos', 'Plan de seguimiento'];
  const activity = {
    title: `Proyecto integrador del módulo ${n}: protocolo de atención de una sede`,
    objective: 'Diseñar y probar un protocolo de atención para una sede ficticia integrando lo aprendido en el módulo.',
    outcomeLinks: outcomeLinks(ids, Math.min(ids.length, 4)),
    deliverable: { description: 'El protocolo final con su diagnóstico, la prueba con casos y el plan de seguimiento.', format: 'Documento con anexos', extent: 'Cinco a ocho páginas' },
    selfCheck: Array.from({ length: pick(C.selfCheck, size) }, (_, i) => `¿La etapa ${(i % C.stages) + 1} quedó conectada con el producto final?`),
    criteria: crit,
    brief: { situation: textLen(n * 7, 260), finalProduct: 'Un protocolo de atención de la sede, probado con casos y con indicadores de seguimiento.' },
    stages: Array.from({ length: C.stages }, (_, i) => ({ id: `S${i + 1}`, title: titles[i % titles.length], purpose: `En esta etapa construyes la parte ${i + 1} del protocolo con los conceptos del capítulo.`, linkedChapter: titles[i % titles.length], tasks: Array.from({ length: pick(C.stageTasks, size) }, (_, j) => `Tarea ${j + 1} de la etapa ${i + 1}: documenta lo que observaste con datos.`), intermediateDeliverable: `Entregable parcial ${i + 1}: una página con el avance de la etapa.`, minutes: stageMin[i] })),
    integration: { instructions: Array.from({ length: pick(C.integration, size) }, (_, i) => `Une el entregable ${i + 1} con los demás y revisa que no se contradigan.`), presentation: 'Presenta el protocolo en cinco diapositivas o un video de tres minutos.' },
    minutesBySection: { stages: stageMin.reduce((a, b) => a + b, 0), integration: minutes === 90 ? 15 : 22, selfCheck: minutes === 90 ? 10 : 13 },
  };
  const solution = {
    stageGuides: activity.stages.map((s) => ({ stageId: s.id, expectedOutput: `Un buen entregable de ${s.id} describe la situación con datos, propone acciones y las conecta con el capítulo.`, commonErrors: Array.from({ length: pick(C.stageErrors, size) }, (_, i) => `Error frecuente ${i + 1}: quedarse en opiniones sin datos.`), checkpointQuestions: Array.from({ length: pick(C.checkpoints, size) }, (_, i) => `¿Qué dato respalda la decisión ${i + 1} de esta etapa?`) })),
    finalProductExemplar: textLen(n * 17, 420),
    correctionGuide: correction(crit),
    teacherNotes: ['Revisa cada entregable parcial antes de la entrega final para dar retroalimentación a tiempo.'],
  };
  return { schemaVersion: 2, chapterId, minutes, kind: 'integrative_project', activity, solution };
}

/** Retroalimentación formativa (30, 60 o 90 min). */
function feedbackDoc(chapterId, minutes, n, o = {}) {
  const size = o.size || 'min';
  const C = {
    30: { reviewCriteria: 3, reviewQuestions: [1, 2], commonErrors: [2, 3], revisionSteps: [2, 3], peer: false, peerInstructions: [0, 0], reflection: [2, 3], selfCheck: [3, 5], criteria: [3, 3], errorGuide: [1, 3] },
    60: { reviewCriteria: 4, reviewQuestions: [2, 3], commonErrors: [4, 6], revisionSteps: [4, 6], peer: true, peerInstructions: [3, 5], reflection: [3, 4], selfCheck: [5, 8], criteria: [3, 4], errorGuide: [2, 6] },
    90: { reviewCriteria: 6, reviewQuestions: [2, 3], commonErrors: [6, 8], revisionSteps: [7, 9], peer: true, peerInstructions: [5, 6], reflection: [5, 6], selfCheck: [6, 8], criteria: [4, 4], errorGuide: [3, 8] },
    120: { reviewCriteria: 8, reviewQuestions: [2, 3], commonErrors: [8, 10], revisionSteps: [9, 12], peer: true, peerInstructions: [6, 8], reflection: [6, 8], selfCheck: [6, 8], criteria: [4, 4], errorGuide: [4, 10] },
  }[minutes];
  const ids = o.outcomeIds && o.outcomeIds.length ? o.outcomeIds : ['OBJ'];
  const crit = criteria(pick(C.criteria, size));
  const rnames = ['Claridad del mensaje', 'Uso de datos', 'Respeto del protocolo', 'Cierre con próximo paso', 'Tono y empatía', 'Registro del caso', 'Uso de los conceptos del módulo', 'Coherencia entre partes'];
  const mbs = { 30: { study: 5, review: 9, revision: 10, reflection: 6 }, 60: { study: 8, review: 14, revision: 18, peerReview: 12, reflection: 8 }, 90: { study: 10, review: 20, revision: 28, peerReview: 18, reflection: 14 }, 120: { study: 12, review: 28, revision: 40, peerReview: 24, reflection: 16 } }[minutes];
  const activity = {
    title: `Revisa y mejora tu trabajo del módulo ${n}`,
    objective: 'Evaluar tu propio producto del módulo con criterios claros y mejorarlo a partir de la retroalimentación.',
    outcomeLinks: outcomeLinks(ids, Math.min(ids.length, 3)),
    deliverable: { description: 'La versión mejorada de tu producto con una tabla de cambios y la reflexión final.', format: 'Documento revisado', extent: 'El producto completo más una página' },
    selfCheck: Array.from({ length: pick(C.selfCheck, size) }, (_, i) => `¿Corregí el aspecto ${i + 1} que encontré en la revisión?`),
    criteria: crit,
    target: { product: 'El informe que entregaste en la Actividad de Aplicación del capítulo anterior.', sourceActivity: 'Actividad de Aplicación del módulo' },
    reviewCriteria: Array.from({ length: C.reviewCriteria }, (_, i) => ({ id: `R${i + 1}`, name: rnames[i], lookFor: `Busca en tu trabajo evidencia de ${rnames[i].toLowerCase()} con ejemplos concretos.`, questions: Array.from({ length: pick(C.reviewQuestions, size) }, (_, j) => `¿Dónde se ve ${rnames[i].toLowerCase()} en el párrafo ${j + 1}?`) })),
    exemplar: { strong: textLen(n * 3 + 1, 120), weak: textLen(n * 3 + 2, 110), commentary: 'El fragmento sólido usa datos y cierra con un próximo paso; el otro se queda en opiniones generales.' },
    commonErrors: Array.from({ length: pick(C.commonErrors, size) }, (_, i) => ({ error: `Error ${i + 1}: prometer un plazo sin confirmarlo.`, howToSpot: 'Busca fechas o plazos sin responsable.', howToFix: 'Agrega quién responde y cuándo, o quita la promesa.' })),
    revision: { steps: Array.from({ length: pick(C.revisionSteps, size) }, (_, i) => `Paso ${i + 1}: corrige el hallazgo más importante de la revisión.`), resubmission: 'Entrega la versión mejorada con una tabla que diga qué cambiaste y por qué.' },
    ...(C.peer ? { peerReview: { instructions: Array.from({ length: pick(C.peerInstructions, size) }, (_, i) => `Instrucción ${i + 1}: comenta un acierto y una mejora con un ejemplo.`), protocol: 'Intercambia tu trabajo con un compañero y usa los criterios de revisión para comentarlo con respeto.' } } : {}),
    reflection: Array.from({ length: pick(C.reflection, size) }, (_, i) => `Reflexión ${i + 1}: ¿qué aprendiste al corregir tu trabajo?`),
    minutesBySection: mbs,
  };
  const solution = {
    feedbackBank: activity.reviewCriteria.map((r) => ({ criterion: r.name, achieved: `Logrado: ${r.name.toLowerCase()} con evidencia.`, developing: `En proceso: ${r.name.toLowerCase()} parcial.`, insufficient: `Insuficiente: sin ${r.name.toLowerCase()}.`, feedbackComment: `Tu trabajo muestra avances en ${r.name.toLowerCase()}; refuerza el ejemplo central.`, nextStep: 'Reescribe el párrafo con un dato concreto.' })),
    errorGuide: Array.from({ length: pick(C.errorGuide, size) }, (_, i) => ({ error: `Error ${i + 1}: plazos sin responsable`, diagnosis: 'Suele venir de no conocer el protocolo de escalamiento.' })),
    correctionGuide: correction(crit),
    teacherNotes: ['Valora más la calidad de la mejora que la cantidad de cambios.'],
  };
  return { schemaVersion: 2, chapterId, minutes, kind: 'formative_feedback', activity, solution };
}

/** Actividad de siempre v2 (en el de 120, con hitos y cantidades reforzadas). */
/**
 * r79.2: forma de la Actividad de siempre v2 por nivel (cantidades MÍNIMAS o MÁXIMAS de STANDARD_SPEC_V2 y un reparto
 * de minutos que respeta los pisos). La comparten este fixture y el LLM falso del E2E (test/e2e-v2/llm-v3.js).
 */
const STANDARD_V2_SHAPE = Object.freeze({
  30: { min: { exercises: 6, examples: 1, instructions: 2, milestones: 0, selfCheck: 4, criteria: 3 }, max: { exercises: 7, examples: 1, instructions: 8, milestones: 0, selfCheck: 8, criteria: 4 }, split: { examples: 5, exercises: 15, workshop: 8, selfCheck: 2 } },
  60: { min: { exercises: 8, examples: 1, instructions: 3, milestones: 2, selfCheck: 5, criteria: 4 }, max: { exercises: 10, examples: 2, instructions: 8, milestones: 2, selfCheck: 8, criteria: 4 }, split: { examples: 8, exercises: 25, workshop: 22, selfCheck: 5 } },
  90: { min: { exercises: 11, examples: 1, instructions: 5, milestones: 3, selfCheck: 6, criteria: 4 }, max: { exercises: 13, examples: 2, instructions: 8, milestones: 3, selfCheck: 8, criteria: 4 }, split: { examples: 10, exercises: 40, workshop: 35, selfCheck: 5 } },
  120: { min: { exercises: 14, examples: 1, instructions: 5, milestones: 4, selfCheck: 6, criteria: 4 }, max: { exercises: 16, examples: 2, instructions: 8, milestones: 4, selfCheck: 8, criteria: 4 }, split: { examples: 15, exercises: 55, workshop: 45, selfCheck: 5 } },
});
const FX_INSTRUCTIONS = ['Prioriza los casos.', 'Redacta la respuesta de los dos más urgentes.', 'Revisa la respuesta con un compañero.', 'Ajusta la respuesta con la retroalimentación recibida.', 'Registra la decisión final en la planilla.', 'Explica qué política aplicaste en cada caso.', 'Calcula el costo de cada solución propuesta.', 'Presenta el resultado al supervisor en un resumen.'];
const FX_MILESTONES = [{ title: 'Priorización', product: 'Una tabla con los casos ordenados por urgencia.' }, { title: 'Respuestas', product: 'Las respuestas escritas de los dos casos urgentes.' }, { title: 'Revisión entre pares', product: 'Las respuestas corregidas con los comentarios del compañero.' }, { title: 'Informe al supervisor', product: 'El resumen con las decisiones y su justificación.' }];
const FX_SELFCHECK = ['¿Escuché el reclamo completo?', '¿Mi solución está dentro de la política?', '¿Expliqué el porqué?', '¿Usé un tono cordial?', '¿Cumplí los hitos del taller?', '¿Revisé los cálculos de costo?', '¿Registré cada decisión?', '¿Incorporé la retroalimentación del compañero?'];
const FX_CRITERIA3 = [{ name: 'Análisis del caso', description: 'Identifica el problema real.', weight: 40 }, { name: 'Solución', description: 'Propone una solución viable.', weight: 40 }, { name: 'Comunicación', description: 'Responde con claridad y cordialidad.', weight: 20 }];
const FX_CRITERIA4 = [{ name: 'Análisis del caso', description: 'Identifica el problema real.', weight: 30 }, { name: 'Solución', description: 'Propone una solución viable.', weight: 30 }, { name: 'Comunicación', description: 'Responde con claridad y cordialidad.', weight: 20 }, { name: 'Hitos del taller', description: 'Entrega los productos intermedios completos.', weight: 20 }];

function standardV2Doc(V, chapterId, minutes, n, o = {}) {
  const d = V.applicationDoc(chapterId, minutes, n);
  d.schemaVersion = 2;
  d.kind = 'standard';
  const shape = STANDARD_V2_SHAPE[minutes];
  const c = shape[o.size === 'max' ? 'max' : 'min'];
  const a = d.activity;
  a.exercises = Array.from({ length: c.exercises }, (_, i) => ({ id: `E${i + 1}`, prompt: `Analiza el caso hipotético ${i + 1} y explica qué harías.`, difficulty: i < 2 ? 'basico' : i < c.exercises - 2 ? 'intermedio' : 'avanzado', answerLines: 3 }));
  const ex0 = a.examples[0];
  a.examples = Array.from({ length: c.examples }, (_, i) => ({ ...ex0, title: `Caso resuelto ${i + 1}` }));
  a.workshop.instructions = FX_INSTRUCTIONS.slice(0, c.instructions);
  if (c.milestones) a.workshop.milestones = FX_MILESTONES.slice(0, c.milestones);
  else delete a.workshop.milestones;
  a.selfCheck = FX_SELFCHECK.slice(0, c.selfCheck);
  a.criteria = (c.criteria === 4 ? FX_CRITERIA4 : FX_CRITERIA3).map((x) => ({ ...x }));
  a.minutesBySection = { ...shape.split };
  d.solution.answers = a.exercises.map((e) => ({ exerciseId: e.id, answer: `Respuesta esperada del ${e.id}.`, explanation: 'Se identifica el problema y se propone una solución dentro de la política.' }));
  d.solution.correctionGuide = a.criteria.map((x) => ({ criterion: x.name, achieved: 'Cumple el criterio por completo.', developing: 'Cumple el criterio en parte.', insufficient: 'No cumple el criterio.' }));
  return d;
}

/** Documento del tipo dado (null = la de siempre v2). */
function kindDoc(V, kind, chapterId, minutes, n, o) {
  if (kind === 'case_study') return caseStudyDoc(chapterId, minutes, n, o);
  if (kind === 'integrative_project') return projectDoc(chapterId, minutes, n, o);
  if (kind === 'formative_feedback') return feedbackDoc(chapterId, minutes, n, o);
  return standardV2Doc(V, chapterId, minutes, n, o);
}

module.exports = { caseStudyDoc, projectDoc, feedbackDoc, standardV2Doc, kindDoc, STANDARD_V2_SHAPE };
