// Fase 2 · Actividades de Aplicación — contrato del artifact `dynamic_application_json` (actividad del estudiante +
// solucionario docente en UN documento: una regeneración nunca los desincroniza).
//
// Lo valida el servidor al completar el item (scheduler.completeItem → validateV3ItemArtifact) y, con las MISMAS
// reglas, el ejecutor del navegador antes de subirlo (espejo en 45-dynamic-generation-executor.js; la paridad la
// prueba scripts/check-application-activities-generation.js). Falla fuerte: un documento incompleto nunca se
// empaqueta como «listo».
//
// Estructura pedida (directiva Fase 2): objetivo, contexto, 1–2 ejemplos resueltos cuando corresponda, 6–10
// ejercicios graduados, taller de aplicación, producto/evidencia, autoevaluación (checklist) y 3–4 criterios.
// La IA elige el GÉNERO de la actividad según la disciplina (cálculo, análisis de caso, procedimiento, producción,
// diseño/construcción, decisión, indagación): no todas las actividades tienen la misma forma.
import { APPLICATION_ACTIVITY_TIERS } from '../study-time/application-tiers';

export const APPLICATION_ACTIVITY_SCHEMA_VERSION = 1 as const;
export const APPLICATION_ARTIFACT_TYPE = 'dynamic_application_json';

export const APPLICATION_GENRES = Object.freeze([
  'calculation', // matemáticas, estadística, finanzas: problemas con procedimiento y resultado
  'case_analysis', // ética, farmacia, derecho: casos con análisis y juicio fundamentado
  'procedure', // SST, enfermería, laboratorio: pasos, verificación y seguridad
  'production', // comunicación, idiomas: producir un texto / pieza con criterios
  'design_build', // informática, ingeniería: diseñar o construir y probar
  'decision', // gestión: elegir entre alternativas con criterios explícitos
  'inquiry', // ciencias sociales / investigación: preguntar, buscar evidencia, concluir
] as const);
export type ApplicationGenre = (typeof APPLICATION_GENRES)[number];
/** Géneros en los que un ejemplo resuelto es obligatorio (se aprende viendo el procedimiento). */
export const GENRES_REQUIRING_EXAMPLE: readonly ApplicationGenre[] = ['calculation', 'procedure', 'design_build'];
export const DIFFICULTIES = Object.freeze(['basico', 'intermedio', 'avanzado'] as const);

/** Ejercicios por nivel de minutos (corta → larga). Siempre dentro de 6–10. */
export const EXERCISES_BY_MINUTES: Readonly<Record<number, { min: number; max: number; examplesMax: number }>> = Object.freeze({
  30: { min: 6, max: 7, examplesMax: 1 },
  60: { min: 6, max: 8, examplesMax: 2 },
  90: { min: 8, max: 10, examplesMax: 2 },
  120: { min: 9, max: 10, examplesMax: 2 },
});
/** Tolerancia de la suma de minutos por sección respecto del nivel (±20 %). */
export const MINUTES_TOLERANCE = 0.2;

const LIM = Object.freeze({ short: 160, text: 1200, long: 2400, answer: 2400 });

export interface ApplicationValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ApplicationValidationContext {
  chapterId: string;
  minutes: number;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

type ErrFn = (path: string, code: string, message: string) => void;

function helpers(err: ErrFn) {
  const text = (v: unknown, path: string, max: number, min = 1): string | null => {
    if (typeof v !== 'string' || v.trim().length < min) {
      err(path, 'APPLICATION_TEXT', `${path} debe ser un texto de al menos ${min} caracteres`);
      return null;
    }
    if (v.length > max) err(path, 'APPLICATION_TEXT_TOO_LONG', `${path} supera ${max} caracteres (${v.length})`);
    return v.trim();
  };
  const list = (v: unknown, path: string, min: number, max: number): unknown[] => {
    if (!Array.isArray(v)) {
      err(path, 'APPLICATION_LIST', `${path} debe ser una lista`);
      return [];
    }
    if (v.length < min || v.length > max) err(path, 'APPLICATION_COUNT', `${path} debe tener entre ${min} y ${max} elementos (tiene ${v.length})`);
    return v;
  };
  return { text, list };
}

function assertMinutes(minutes: number): void {
  if (!(APPLICATION_ACTIVITY_TIERS as readonly number[]).includes(minutes)) {
    throw new Error(`V3_VALIDATION_CONTEXT: Actividad de Aplicación con minutos inválidos ${JSON.stringify(minutes)}`);
  }
}

/**
 * Parte del ESTUDIANTE (`activity`). La valida el ejecutor tras la 1.ª pasada y el servidor dentro del documento.
 * Devuelve los errores y, para el solucionario, los ids de los ejercicios y los nombres de los criterios.
 */
export function validateApplicationStudentPart(a: unknown, minutes: number): { errors: ApplicationValidationError[]; exerciseIds: string[]; criteriaNames: string[] } {
  assertMinutes(minutes);
  const errors: ApplicationValidationError[] = [];
  const err: ErrFn = (path, code, message) => errors.push({ path, code, message });
  const { text, list } = helpers(err);
  const ids: string[] = [];
  const names: string[] = [];
  if (!isObj(a)) {
    err('$.activity', 'APPLICATION_SHAPE', 'falta la actividad del estudiante');
    return { errors, exerciseIds: ids, criteriaNames: names };
  }
  const genre = a.genre;
  const knownGenre = (APPLICATION_GENRES as readonly string[]).includes(genre);
  if (!knownGenre) err('$.activity.genre', 'APPLICATION_GENRE', `genre debe ser uno de ${APPLICATION_GENRES.join(', ')}`);
  text(a.title, '$.activity.title', LIM.short, 4);
  text(a.objective, '$.activity.objective', LIM.text, 20);
  text(a.context, '$.activity.context', LIM.long, 60);
  const bounds = EXERCISES_BY_MINUTES[minutes];
  const examples = list(a.examples, '$.activity.examples', knownGenre && GENRES_REQUIRING_EXAMPLE.includes(genre) ? 1 : 0, bounds.examplesMax);
  examples.forEach((ex, i) => {
    const p = `$.activity.examples[${i}]`;
    if (!isObj(ex)) return err(p, 'APPLICATION_SHAPE', `${p} debe ser un objeto`);
    text(ex.title, `${p}.title`, LIM.short, 4);
    text(ex.problem, `${p}.problem`, LIM.text, 20);
    list(ex.steps, `${p}.steps`, 2, 10).forEach((st, j) => text(st, `${p}.steps[${j}]`, LIM.text, 3));
    text(ex.result, `${p}.result`, LIM.text, 3);
  });
  const exercises = list(a.exercises, '$.activity.exercises', bounds.min, bounds.max);
  let lastDifficulty = -1;
  exercises.forEach((e, i) => {
    const p = `$.activity.exercises[${i}]`;
    if (!isObj(e)) {
      ids.push('');
      return err(p, 'APPLICATION_SHAPE', `${p} debe ser un objeto`);
    }
    const want = `E${i + 1}`;
    if (e.id !== want) err(`${p}.id`, 'APPLICATION_EXERCISE_ID', `${p}.id debe ser "${want}" (en orden)`);
    ids.push(String(e.id));
    text(e.prompt, `${p}.prompt`, LIM.text, 15);
    const d = (DIFFICULTIES as readonly string[]).indexOf(e.difficulty);
    if (d < 0) err(`${p}.difficulty`, 'APPLICATION_DIFFICULTY', `${p}.difficulty debe ser ${DIFFICULTIES.join(' | ')}`);
    else if (d < lastDifficulty) err(`${p}.difficulty`, 'APPLICATION_DIFFICULTY_ORDER', 'los ejercicios van de menor a mayor dificultad');
    else lastDifficulty = d;
    if (!Number.isInteger(e.answerLines) || e.answerLines < 1 || e.answerLines > 15) err(`${p}.answerLines`, 'APPLICATION_ANSWER_LINES', `${p}.answerLines debe ser un entero de 1 a 15 (renglones para responder en papel)`);
  });
  if (exercises.length >= 3 && lastDifficulty === 0) err('$.activity.exercises', 'APPLICATION_NOT_GRADED', 'los ejercicios deben subir de dificultad (al menos uno intermedio o avanzado)');
  const w = a.workshop;
  if (!isObj(w)) err('$.activity.workshop', 'APPLICATION_SHAPE', 'falta el taller de aplicación');
  else {
    text(w.title, '$.activity.workshop.title', LIM.short, 4);
    text(w.situation, '$.activity.workshop.situation', LIM.long, 60);
    list(w.instructions, '$.activity.workshop.instructions', 2, 8).forEach((x, i) => text(x, `$.activity.workshop.instructions[${i}]`, LIM.text, 8));
  }
  const dv = a.deliverable;
  if (!isObj(dv)) err('$.activity.deliverable', 'APPLICATION_SHAPE', 'falta el producto o evidencia');
  else {
    text(dv.description, '$.activity.deliverable.description', LIM.text, 15);
    text(dv.format, '$.activity.deliverable.format', LIM.short, 3);
    text(dv.extent, '$.activity.deliverable.extent', LIM.short, 2);
  }
  list(a.selfCheck, '$.activity.selfCheck', 4, 8).forEach((x, i) => text(x, `$.activity.selfCheck[${i}]`, LIM.text, 8));
  const criteria = list(a.criteria, '$.activity.criteria', 3, 4);
  let weightSum = 0;
  criteria.forEach((c, i) => {
    const p = `$.activity.criteria[${i}]`;
    if (!isObj(c)) {
      names.push('');
      return err(p, 'APPLICATION_SHAPE', `${p} debe ser un objeto`);
    }
    const n = text(c.name, `${p}.name`, LIM.short, 3);
    if (n && names.includes(n)) err(`${p}.name`, 'APPLICATION_CRITERIA_DUPLICATE', `criterio repetido: ${n}`);
    names.push(n ?? '');
    text(c.description, `${p}.description`, LIM.text, 10);
    if (!Number.isInteger(c.weight) || c.weight < 5 || c.weight > 70) err(`${p}.weight`, 'APPLICATION_CRITERIA_WEIGHT', `${p}.weight debe ser un entero de 5 a 70`);
    else weightSum += c.weight;
  });
  if (criteria.length && weightSum !== 100) err('$.activity.criteria', 'APPLICATION_CRITERIA_WEIGHTS', `los pesos de los criterios deben sumar 100 (suman ${weightSum})`);
  const mbs = a.minutesBySection;
  const SECTIONS = ['examples', 'exercises', 'workshop', 'selfCheck'];
  if (!isObj(mbs)) err('$.activity.minutesBySection', 'APPLICATION_SHAPE', 'falta minutesBySection');
  else {
    let total = 0;
    for (const k of SECTIONS) {
      if (!Number.isInteger(mbs[k]) || mbs[k] < 0 || mbs[k] > 120) err(`$.activity.minutesBySection.${k}`, 'APPLICATION_SECTION_MINUTES', `${k} debe ser un entero de 0 a 120`);
      else total += mbs[k];
    }
    for (const k of Object.keys(mbs)) if (!SECTIONS.includes(k)) err(`$.activity.minutesBySection.${k}`, 'APPLICATION_SECTION_MINUTES', `sección desconocida: ${k}`);
    if (Math.abs(total - minutes) > minutes * MINUTES_TOLERANCE) {
      err('$.activity.minutesBySection', 'APPLICATION_MINUTES_BUDGET', `las secciones suman ${total} min; el nivel es ${minutes} min (±${Math.round(MINUTES_TOLERANCE * 100)} %)`);
    }
  }
  return { errors, exerciseIds: ids, criteriaNames: names };
}

/** Parte DOCENTE (`solution`): cubre EXACTAMENTE los ejercicios y los criterios de la actividad, en orden. */
export function validateApplicationSolutionPart(s: unknown, exerciseIds: readonly string[], criteriaNames: readonly string[]): ApplicationValidationError[] {
  const errors: ApplicationValidationError[] = [];
  const err: ErrFn = (path, code, message) => errors.push({ path, code, message });
  const { text, list } = helpers(err);
  if (!isObj(s)) {
    err('$.solution', 'APPLICATION_SHAPE', 'falta el solucionario docente');
    return errors;
  }
  list(s.answers, '$.solution.answers', exerciseIds.length, exerciseIds.length).forEach((x, i) => {
    const p = `$.solution.answers[${i}]`;
    if (!isObj(x)) return err(p, 'APPLICATION_SHAPE', `${p} debe ser un objeto`);
    if (x.exerciseId !== exerciseIds[i]) err(`${p}.exerciseId`, 'APPLICATION_SOLUTION_COVERAGE', `${p}.exerciseId debe ser "${exerciseIds[i] ?? '?'}" (mismo orden que los ejercicios)`);
    text(x.answer, `${p}.answer`, LIM.answer, 1);
    text(x.explanation, `${p}.explanation`, LIM.answer, 15);
  });
  text(s.workshopSolution, '$.solution.workshopSolution', LIM.long * 2, 60);
  list(s.correctionGuide, '$.solution.correctionGuide', criteriaNames.length, criteriaNames.length).forEach((g, i) => {
    const p = `$.solution.correctionGuide[${i}]`;
    if (!isObj(g)) return err(p, 'APPLICATION_SHAPE', `${p} debe ser un objeto`);
    if (g.criterion !== criteriaNames[i]) err(`${p}.criterion`, 'APPLICATION_SOLUTION_COVERAGE', `${p}.criterion debe ser «${criteriaNames[i] ?? '?'}» (mismo orden que los criterios)`);
    text(g.achieved, `${p}.achieved`, LIM.text, 10);
    text(g.developing, `${p}.developing`, LIM.text, 10);
    text(g.insufficient, `${p}.insufficient`, LIM.text, 10);
  });
  list(s.teacherNotes, '$.solution.teacherNotes', 1, 6).forEach((x, i) => text(x, `$.solution.teacherNotes[${i}]`, LIM.text, 10));
  return errors;
}

/**
 * Valida el documento completo. Devuelve TODOS los errores (vacío = válido). Nunca lanza por contenido; lanza
 * solo si el contexto es inválido (bug de integración).
 */
export function validateApplicationActivityDoc(doc: unknown, ctx: ApplicationValidationContext): ApplicationValidationError[] {
  if (!ctx || typeof ctx.chapterId !== 'string') throw new Error(`V3_VALIDATION_CONTEXT: Actividad de Aplicación sin chapterId ${JSON.stringify(ctx)}`);
  assertMinutes(ctx.minutes);
  if (!isObj(doc)) return [{ path: '$', code: 'APPLICATION_SHAPE', message: 'el documento debe ser un objeto' }];
  const errors: ApplicationValidationError[] = [];
  if (doc.schemaVersion !== APPLICATION_ACTIVITY_SCHEMA_VERSION) errors.push({ path: '$.schemaVersion', code: 'APPLICATION_SCHEMA_VERSION', message: `schemaVersion debe ser ${APPLICATION_ACTIVITY_SCHEMA_VERSION}` });
  if (doc.chapterId !== ctx.chapterId) errors.push({ path: '$.chapterId', code: 'CHAPTER_ID_MISMATCH', message: `chapterId debe ser "${ctx.chapterId}"` });
  if (doc.minutes !== ctx.minutes) errors.push({ path: '$.minutes', code: 'APPLICATION_MINUTES_MISMATCH', message: `minutes debe ser ${ctx.minutes} (nivel del Manifest)` });
  const st = validateApplicationStudentPart(doc.activity, ctx.minutes);
  errors.push(...st.errors);
  errors.push(...validateApplicationSolutionPart(doc.solution, st.exerciseIds, st.criteriaNames));
  return errors;
}

/** Métricas para el output_summary del item (no bloquean). */
export function applicationActivitySummary(doc: any): Record<string, unknown> {
  const a = doc?.activity ?? {};
  return {
    genre: a.genre ?? null,
    exerciseCount: Array.isArray(a.exercises) ? a.exercises.length : 0,
    exampleCount: Array.isArray(a.examples) ? a.examples.length : 0,
    criteriaCount: Array.isArray(a.criteria) ? a.criteria.length : 0,
    minutes: doc?.minutes ?? null,
  };
}
