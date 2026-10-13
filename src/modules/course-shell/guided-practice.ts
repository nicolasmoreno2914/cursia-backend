// Loop 9 B · «Práctica guiada del capítulo» — contrato del artifact `dynamic_guided_practice_json`.
//
// Formativa y SIN nota, dentro del alcance del capítulo de CONTENIDO: 2–3 ejercicios (caso, problema resuelto o
// análisis de decisión) con situación, consignas, producto esperado, criterios de autoevaluación y una RESPUESTA MODELO
// que el estudiante revisa después de intentarlo. NO es una Actividad de Aplicación con otro nombre: sin solucionario
// oculto, sin pesos ni calificación, más corta.
//
// Lo valida el servidor al completar el item (scheduler.completeItem → validateV3ItemArtifact) y, con las MISMAS reglas,
// el ejecutor del navegador antes de subirlo (espejo en 45-dynamic-generation-executor.js; paridad: scripts/
// check-guided-practice.js y el harness del frontend test-67). El empaque lo vuelve a validar (nunca empaqueta uno roto).
// chapterId, minutes, los ids y los minutos de cada ejercicio los pone Cursia (plan del nivel), nunca la IA.
import { GUIDED_PRACTICE_TIERS, guidedPracticeExercisePlan, isGuidedPracticeMinutes } from '../study-time/guided-practice-tiers';

export const GUIDED_PRACTICE_SCHEMA_VERSION = 1 as const;
export const GUIDED_PRACTICE_ARTIFACT_TYPE = 'dynamic_guided_practice_json';
export const GUIDED_PRACTICE_KINDS = Object.freeze(['case_analysis', 'worked_problem', 'decision_analysis'] as const);
export type GuidedPracticeKind = (typeof GUIDED_PRACTICE_KINDS)[number];

/** Límites (caracteres) del documento v1. Los mínimos que dependen de los minutos del ejercicio están en FLOORS. */
export const GUIDED_PRACTICE_LIMITS = Object.freeze({
  titleMax: 90,
  situationMin: 300,
  situationMax: 1400,
  tasksMin: 3,
  tasksMax: 6,
  taskMin: 10,
  taskMax: 400,
  expectedProductMin: 10,
  expectedProductMax: 300,
  criteriaMin: 3,
  criteriaMax: 5,
  criterionNameMax: 80,
  criterionDescriptorMin: 10,
  criterionDescriptorMax: 300,
  modelAnswerMin: 450,
  modelAnswerMax: 2200,
});

/**
 * Fix round 1 (C1): los minutos que se acreditan tienen que estar respaldados por trabajo. Pisos por minutos del ejercicio
 * (los fija Cursia): situación, cantidad de consignas, respuesta modelo y producto esperado crecen con el tiempo.
 */
export const GUIDED_PRACTICE_FLOORS: Readonly<Record<number, { situationMin: number; tasksMin: number; modelAnswerMin: number; expectedProductMin: number }>> = Object.freeze({
  20: Object.freeze({ situationMin: 300, tasksMin: 3, modelAnswerMin: 450, expectedProductMin: 10 }),
  30: Object.freeze({ situationMin: 500, tasksMin: 4, modelAnswerMin: 800, expectedProductMin: 20 }),
  40: Object.freeze({ situationMin: 700, tasksMin: 4, modelAnswerMin: 1100, expectedProductMin: 40 }),
});

/**
 * Fix round 1 (C1): cada consigna exige PRODUCIR algo (analizar, decidir, calcular, justificar…), nunca solo recordar.
 * Consignas que empiezan con un verbo de recuerdo («Define», «Menciona», «Enumera», «Nombra», «Lista», «Recuerda», «Cita»,
 * «¿Qué es…?») se rechazan.
 */
export const GUIDED_PRACTICE_RECALL_TASK_RE = /^\s*(?:¿\s*)?(?:defin[ea]|mencion[ae]|enumer[ae]|nombr[ae]|list[ae]|recuerd[ae]|cit[ae]|qu[eé] es|cu[aá]l es la definici[oó]n)(?![\p{L}])/iu;

export const GUIDED_PRACTICE_DOC_KEYS = Object.freeze(['schemaVersion', 'chapterId', 'minutes', 'exercises']);
export const GUIDED_PRACTICE_EXERCISE_KEYS = Object.freeze(['id', 'minutes', 'kind', 'title', 'situation', 'tasks', 'expectedProduct', 'criteria', 'modelAnswer']);
export const GUIDED_PRACTICE_CRITERION_KEYS = Object.freeze(['name', 'descriptor']);

/**
 * La práctica guiada no menciona otros recursos del curso (video, H5P, Actividad de Aplicación, exámenes, audiolibro,
 * presentación, Libro Guía): se lee sola, en la página del capítulo y en el Libro. Frases que nombran RECURSOS del curso
 * (un «examen físico» o una «videollamada» del caso no cuentan).
 */
export const GUIDED_PRACTICE_RESOURCE_RE =
  /\bvideos? (interactivos?|del cap[ií]tulo|del curso|del m[oó]dulo)\b|\bH5P\b|\bactividad(es)? de aplicaci[oó]n\b|\bex[aá]men(es)? (del|de este) (m[oó]dulo|curso)\b|\bevaluaci[oó]n final\b|\baudiolibro\b|\bpresentaci[oó]n del cap[ií]tulo\b|\blibro gu[ií]a\b|\bSCORM\b/i;

export interface GuidedPracticeValidationError {
  path: string;
  code: string;
  message: string;
}

export interface GuidedPracticeValidationContext {
  chapterId: string;
  minutes: number;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * ¿La respuesta modelo responde las consignas EN ORDEN? Una marca «1.» / «1)» / «Consigna 1.» AL INICIO DE LÍNEA por
 * consigna, en orden creciente (fix round 1, M1: cifras como «2.000» o «3,5 %» dentro del texto no cuentan).
 */
export function guidedPracticeAnswerCoversTasks(answer: string, taskCount: number): boolean {
  let from = 0;
  for (let k = 1; k <= taskCount; k++) {
    const re = new RegExp(`(?:^|\\n)[ \\t]*(?:consigna[ \\t]+)?${k}[.)][ \\t]`, 'gi');
    re.lastIndex = from;
    const m = re.exec(answer);
    if (!m) return false;
    from = m.index + m[0].length;
  }
  return true;
}

/**
 * Valida el documento completo. Devuelve TODOS los errores (vacío = válido). Nunca lanza por contenido; lanza solo si el
 * contexto es inválido (bug de integración).
 */
export function validateGuidedPracticeDoc(doc: unknown, ctx: GuidedPracticeValidationContext): GuidedPracticeValidationError[] {
  if (!ctx || typeof ctx.chapterId !== 'string' || !ctx.chapterId) throw new Error(`V3_VALIDATION_CONTEXT: práctica guiada sin chapterId ${JSON.stringify(ctx)}`);
  if (!isGuidedPracticeMinutes(ctx.minutes)) throw new Error(`V3_VALIDATION_CONTEXT: práctica guiada con minutos inválidos ${JSON.stringify(ctx.minutes)} (${GUIDED_PRACTICE_TIERS.join('/')})`);
  const L = GUIDED_PRACTICE_LIMITS;
  const errors: GuidedPracticeValidationError[] = [];
  const err = (path: string, code: string, message: string) => errors.push({ path, code, message });
  if (!isObj(doc)) return [{ path: '$', code: 'GUIDED_PRACTICE_SHAPE', message: 'el documento debe ser un objeto' }];
  for (const k of Object.keys(doc)) if (!GUIDED_PRACTICE_DOC_KEYS.includes(k)) err(`$.${k}`, 'GUIDED_PRACTICE_SHAPE', `campo desconocido: ${k} (la práctica guiada no tiene solucionario oculto ni nota)`);
  if (doc.schemaVersion !== GUIDED_PRACTICE_SCHEMA_VERSION) err('$.schemaVersion', 'GUIDED_PRACTICE_SCHEMA_VERSION', `schemaVersion debe ser ${GUIDED_PRACTICE_SCHEMA_VERSION}`);
  if (doc.chapterId !== ctx.chapterId) err('$.chapterId', 'CHAPTER_ID_MISMATCH', `chapterId debe ser "${ctx.chapterId}"`);
  if (doc.minutes !== ctx.minutes) err('$.minutes', 'GUIDED_PRACTICE_MINUTES_MISMATCH', `minutes debe ser ${ctx.minutes} (nivel del Manifest)`);
  const plan = guidedPracticeExercisePlan(ctx.minutes);
  const text = (v: unknown, path: string, min: number, max: number): string | null => {
    if (typeof v !== 'string' || v.trim().length < Math.max(1, min)) {
      err(path, 'GUIDED_PRACTICE_TEXT', `${path} debe ser un texto de al menos ${Math.max(1, min)} caracteres`);
      return null;
    }
    if (v.length > max) err(path, 'GUIDED_PRACTICE_TEXT_TOO_LONG', `${path} supera ${max} caracteres (${v.length})`);
    if (GUIDED_PRACTICE_RESOURCE_RE.test(v)) err(path, 'GUIDED_PRACTICE_RESOURCE_MENTION', `${path} menciona otro recurso del curso («${(GUIDED_PRACTICE_RESOURCE_RE.exec(v) || [''])[0]}»): la práctica guiada se lee sola`);
    return v;
  };
  if (!Array.isArray(doc.exercises)) {
    err('$.exercises', 'GUIDED_PRACTICE_SHAPE', 'exercises debe ser una lista');
    return errors;
  }
  if (doc.exercises.length !== plan.length) err('$.exercises', 'GUIDED_PRACTICE_COUNT', `exercises debe tener ${plan.length} ejercicios para ${ctx.minutes} min (tiene ${doc.exercises.length})`);
  doc.exercises.forEach((e: unknown, i: number) => {
    const p = `$.exercises[${i}]`;
    if (!isObj(e)) return err(p, 'GUIDED_PRACTICE_SHAPE', `${p} debe ser un objeto`);
    for (const k of Object.keys(e)) if (!GUIDED_PRACTICE_EXERCISE_KEYS.includes(k)) err(`${p}.${k}`, 'GUIDED_PRACTICE_SHAPE', `campo desconocido en el ejercicio: ${k}`);
    const want = plan[i];
    if (want) {
      if (e.id !== want.id) err(`${p}.id`, 'GUIDED_PRACTICE_EXERCISE_ID', `${p}.id debe ser "${want.id}" (en orden)`);
      if (e.minutes !== want.minutes) err(`${p}.minutes`, 'GUIDED_PRACTICE_EXERCISE_MINUTES', `${p}.minutes debe ser ${want.minutes} (lo fija Cursia)`);
    }
    if (!(GUIDED_PRACTICE_KINDS as readonly string[]).includes(e.kind)) err(`${p}.kind`, 'GUIDED_PRACTICE_KIND', `${p}.kind debe ser ${GUIDED_PRACTICE_KINDS.join(' | ')}`);
    text(e.title, `${p}.title`, 4, L.titleMax);
    // C1: pisos según los minutos del ejercicio (los del plan de Cursia; un ejercicio de más usa los de 20 min).
    const F = GUIDED_PRACTICE_FLOORS[want ? want.minutes : 20] || GUIDED_PRACTICE_FLOORS[20];
    text(e.situation, `${p}.situation`, F.situationMin, L.situationMax);
    let taskCount = 0;
    if (!Array.isArray(e.tasks)) err(`${p}.tasks`, 'GUIDED_PRACTICE_SHAPE', `${p}.tasks debe ser una lista`);
    else {
      taskCount = e.tasks.length;
      if (e.tasks.length < F.tasksMin || e.tasks.length > L.tasksMax) err(`${p}.tasks`, 'GUIDED_PRACTICE_COUNT', `${p}.tasks debe tener entre ${F.tasksMin} y ${L.tasksMax} consignas para ${want ? want.minutes : 20} min (tiene ${e.tasks.length})`);
      e.tasks.forEach((t: unknown, j: number) => {
        const tt = text(t, `${p}.tasks[${j}]`, L.taskMin, L.taskMax);
        if (tt && GUIDED_PRACTICE_RECALL_TASK_RE.test(tt)) err(`${p}.tasks[${j}]`, 'GUIDED_PRACTICE_TASK_RECALL', `${p}.tasks[${j}] solo pide recordar («${tt.slice(0, 40)}»): cada consigna debe pedir analizar, decidir, calcular o justificar`);
      });
    }
    text(e.expectedProduct, `${p}.expectedProduct`, F.expectedProductMin, L.expectedProductMax);
    if (!Array.isArray(e.criteria)) err(`${p}.criteria`, 'GUIDED_PRACTICE_SHAPE', `${p}.criteria debe ser una lista`);
    else {
      if (e.criteria.length < L.criteriaMin || e.criteria.length > L.criteriaMax) err(`${p}.criteria`, 'GUIDED_PRACTICE_COUNT', `${p}.criteria debe tener entre ${L.criteriaMin} y ${L.criteriaMax} criterios (tiene ${e.criteria.length})`);
      const names: string[] = [];
      e.criteria.forEach((c: unknown, j: number) => {
        const cp = `${p}.criteria[${j}]`;
        if (!isObj(c)) return err(cp, 'GUIDED_PRACTICE_SHAPE', `${cp} debe ser un objeto { name, descriptor }`);
        for (const k of Object.keys(c)) if (!GUIDED_PRACTICE_CRITERION_KEYS.includes(k)) err(`${cp}.${k}`, 'GUIDED_PRACTICE_SHAPE', `campo desconocido en el criterio: ${k} (sin pesos ni puntajes: es formativa)`);
        const n = text(c.name, `${cp}.name`, 3, L.criterionNameMax);
        if (n && names.includes(n.trim().toLowerCase())) err(`${cp}.name`, 'GUIDED_PRACTICE_CRITERIA_DUPLICATE', `criterio repetido: ${n}`);
        if (n) names.push(n.trim().toLowerCase());
        text(c.descriptor, `${cp}.descriptor`, L.criterionDescriptorMin, L.criterionDescriptorMax);
      });
    }
    const ans = text(e.modelAnswer, `${p}.modelAnswer`, F.modelAnswerMin, L.modelAnswerMax);
    if (ans && taskCount >= L.tasksMin && !guidedPracticeAnswerCoversTasks(ans, taskCount)) {
      err(`${p}.modelAnswer`, 'GUIDED_PRACTICE_ANSWER_ORDER', `${p}.modelAnswer debe responder las ${taskCount} consignas en orden, una por línea, cada una empezando con «1. », «2. », …`);
    }
  });
  return errors;
}

/** Métricas para el output_summary del item (no bloquean). */
export function guidedPracticeSummary(doc: any): Record<string, unknown> {
  const xs = Array.isArray(doc?.exercises) ? doc.exercises : [];
  return {
    exerciseCount: xs.length,
    minutes: doc?.minutes ?? null,
    kinds: xs.map((e: any) => e?.kind ?? null),
  };
}
