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
  30: Object.freeze({ situationMin: 550, tasksMin: 4, modelAnswerMin: 950, expectedProductMin: 20 }),
  40: Object.freeze({ situationMin: 800, tasksMin: 5, modelAnswerMin: 1400, expectedProductMin: 60 }),
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
  /** Fix N1: casos del módulo que no se repiten (práctica + AA). Ausente = sin chequeo de choque. */
  avoid?: GuidedPracticeAvoid | null;
}

/** Fix I5/N1: lo que los ejercicios guiados no repiten (títulos de las prácticas del módulo y casos de sus AA). */
export interface GuidedPracticeAvoid {
  practiceChapterTitles: string[];
  applicationCases: { title: string | null; workshopTitle: string | null; names: string[] }[];
  /**
   * Loop 10 C1-b: huellas de los ejercicios guiados YA completados en el MISMO run (otros capítulos): título + firma
   * compacta de la situación (guidedPracticeSignature). Acotado: ≤ GUIDED_PRACTICE_DISTINCT.previousMax ejercicios.
   * Ausente = nada que comparar (runs anteriores al Loop 10 no tienen huellas: no se comparan).
   */
  previousExercises?: GuidedPracticePreviousExercise[];
}

/** Loop 10 C1-b: huella de un ejercicio guiado de otro capítulo del run. */
export interface GuidedPracticePreviousExercise {
  chapterId: string;
  title: string;
  /** Firma de la situación: hasta `signatureMax` hashes FNV-1a de 32 bits (8 hex cada uno), ordenados y concatenados. */
  sig: string;
}

/**
 * Loop 10 C1 — guardia de calidad de los ejercicios guiados (los minutos que se acreditan no se inflan con repetición):
 *  a) en un documento: al menos 2 tipos (`kind`) distintos cuando hay 2+ ejercicios; ninguna pareja casi igual
 *     (Jaccard de shingles de 3 palabras ≥ situationJaccard entre situaciones, o ≥ tasksJaccard entre consignas);
 *  b) en el curso: ningún ejercicio repite el título de un ejercicio guiado de OTRO capítulo del run ni su situación
 *     (Jaccard estimada con las firmas ≥ situationJaccard);
 *  c) la respuesta modelo responde CADA consigna con contenido (cada tramo ≥ answerSegmentMin caracteres; sin
 *     remisiones del tipo «ver la tabla del capítulo»).
 * Espejo EXACTO en el ejecutor (DYN_GUIDED_PRACTICE_DISTINCT).
 */
export const GUIDED_PRACTICE_DISTINCT = Object.freeze({
  shingleSize: 3,
  situationJaccard: 0.5,
  tasksJaccard: 0.6,
  signatureMax: 64,
  previousMax: 40,
  answerSegmentMin: 60,
  answerStubMaxChars: 160,
});

/** C1-c: tramo de respuesta que solo remite a otra parte («Ver la tabla del capítulo», «Consulta la sección 2»). */
export const GUIDED_PRACTICE_ANSWER_STUB_RE = /\b(?:ver|v[eé]ase|consulta(?:r)?|revisa(?:r)?|rem[ií]tete)\b[^.\n]{0,40}\b(?:tabla|cuadro|secci[oó]n|cap[ií]tulo|apartado|texto|punto|respuesta)\b/i;

/** Palabras normalizadas (minúsculas, sin tildes, solo [a-z0-9ñ]). Espejo de _dynGpWords. */
export function guidedPracticeWords(t: unknown): string[] {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Shingles de `shingleSize` palabras consecutivas (únicos, en orden de aparición). Menos palabras = un solo shingle. */
export function guidedPracticeShingles(t: unknown): string[] {
  const w = guidedPracticeWords(t);
  const k = GUIDED_PRACTICE_DISTINCT.shingleSize;
  if (!w.length) return [];
  if (w.length < k) return [w.join(' ')];
  const seen = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) seen.add(w.slice(i, i + k).join(' '));
  return [...seen];
}

/** Jaccard de dos conjuntos de shingles (0 si alguno está vacío). */
export function guidedPracticeJaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const A = new Set(a);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** FNV-1a de 32 bits sobre las unidades UTF-16 (8 hex). Espejo de _dynGpHash. */
export function guidedPracticeHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function sigHashes(sig: unknown): string[] {
  if (typeof sig !== 'string' || !/^(?:[0-9a-f]{8})*$/.test(sig)) return [];
  const out: string[] = [];
  for (let i = 0; i < sig.length && out.length < GUIDED_PRACTICE_DISTINCT.signatureMax; i += 8) out.push(sig.slice(i, i + 8));
  return out;
}

/** Firma compacta de un texto: los `signatureMax` hashes más chicos de sus shingles (bottom-k), ordenados. */
export function guidedPracticeSignature(t: unknown): string {
  const hs = [...new Set(guidedPracticeShingles(t).map(guidedPracticeHash))].sort();
  return hs.slice(0, GUIDED_PRACTICE_DISTINCT.signatureMax).join('');
}

/**
 * Jaccard estimada entre dos firmas (estimador bottom-k): de los k hashes más chicos de la unión, la fracción que está
 * en ambas. Exacta si los dos textos tienen ≤ k shingles.
 */
export function guidedPracticeSignatureJaccard(sigA: string, sigB: string): number {
  const a = sigHashes(sigA);
  const b = sigHashes(sigB);
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  const union = [...new Set([...a, ...b])].sort().slice(0, GUIDED_PRACTICE_DISTINCT.signatureMax);
  let both = 0;
  for (const h of union) if (A.has(h) && B.has(h)) both++;
  return both / union.length;
}

/** Huellas de los ejercicios de un documento (para el output_summary y el `avoid` de los capítulos siguientes). */
export function guidedPracticeFingerprints(doc: unknown): { id: string | null; title: string; sig: string }[] {
  if (!isObj(doc) || !Array.isArray((doc as any).exercises)) return [];
  return ((doc as any).exercises as unknown[]).filter(isObj).map((e: any) => ({
    id: typeof e.id === 'string' ? e.id : null,
    title: String(e.title || '').slice(0, GUIDED_PRACTICE_LIMITS.titleMax),
    sig: guidedPracticeSignature(e.situation),
  }));
}

/**
 * C1-c: los tramos de la respuesta modelo, uno por consigna (entre la marca «k.» y la siguiente). null si las marcas
 * no están completas y en orden (eso ya lo informa GUIDED_PRACTICE_ANSWER_ORDER).
 */
export function guidedPracticeAnswerSegments(answer: string, taskCount: number): string[] | null {
  const marks: { start: number; end: number }[] = [];
  let from = 0;
  for (let k = 1; k <= taskCount; k++) {
    const re = new RegExp(`(?:^|\\n)[ \\t]*(?:consigna[ \\t]+)?${k}[.)][ \\t]`, 'gi');
    re.lastIndex = from;
    const m = re.exec(answer);
    if (!m) return null;
    marks.push({ start: m.index, end: m.index + m[0].length });
    from = m.index + m[0].length;
  }
  return marks.map((m, i) => answer.slice(m.end, i + 1 < marks.length ? marks[i + 1].start : answer.length).trim());
}

/**
 * C1-a: distinción DENTRO del documento (tipos y parejas casi iguales). Espejo de dynGuidedPracticeDistinctErrors.
 */
export function guidedPracticeDistinctErrors(doc: unknown): GuidedPracticeValidationError[] {
  const out: GuidedPracticeValidationError[] = [];
  if (!isObj(doc) || !Array.isArray((doc as any).exercises)) return out;
  const xs = ((doc as any).exercises as unknown[]).map((e) => (isObj(e) ? e : null));
  const D = GUIDED_PRACTICE_DISTINCT;
  const kinds = xs.map((e) => (e && (GUIDED_PRACTICE_KINDS as readonly string[]).includes(e.kind) ? String(e.kind) : null));
  if (xs.length >= 2 && kinds.every((k) => k !== null) && new Set(kinds).size < 2) {
    out.push({ path: '$.exercises', code: 'GUIDED_PRACTICE_KIND_REPEATED', message: `los ${xs.length} ejercicios son del mismo tipo (${kinds[0]}): usa al menos 2 tipos distintos (${GUIDED_PRACTICE_KINDS.join(', ')})` });
  }
  const sit = xs.map((e) => (e ? guidedPracticeShingles(e.situation) : []));
  const tasks = xs.map((e) => (e && Array.isArray(e.tasks) ? [...new Set(e.tasks.flatMap((t: unknown) => guidedPracticeShingles(t)))] as string[] : []));
  const titles = xs.map((e) => (e ? guidedPracticeNormTitle(e.title) : ''));
  for (let j = 1; j < xs.length; j++) {
    if (!xs[j]) continue;
    for (let i = 0; i < j; i++) {
      if (!xs[i]) continue;
      const p = `$.exercises[${j}]`;
      if (titles[j] && titles[j] === titles[i]) { out.push({ path: `${p}.title`, code: 'GUIDED_PRACTICE_DUPLICATE', message: `${p}.title repite el título del ejercicio ${i + 1}: cada ejercicio es una situación distinta` }); break; }
      const js = guidedPracticeJaccard(sit[i], sit[j]);
      if (js >= D.situationJaccard) { out.push({ path: `${p}.situation`, code: 'GUIDED_PRACTICE_DUPLICATE', message: `${p}.situation es casi igual a la del ejercicio ${i + 1} (similitud ${js.toFixed(2)}): usa otra situación, con otras personas y otro problema` }); break; }
      const jt = guidedPracticeJaccard(tasks[i], tasks[j]);
      if (jt >= D.tasksJaccard) { out.push({ path: `${p}.tasks`, code: 'GUIDED_PRACTICE_DUPLICATE', message: `${p}.tasks son casi iguales a las del ejercicio ${i + 1} (similitud ${jt.toFixed(2)}): cada ejercicio pide un trabajo distinto` }); break; }
    }
  }
  return out;
}

/**
 * C1-b: choque DURO con un ejercicio guiado de OTRO capítulo del run (mismo título normalizado, o situación con
 * Jaccard estimada ≥ situationJaccard). Espejo de dynGuidedPracticeRunClashes.
 */
export function guidedPracticeRunClashes(doc: unknown, avoid: GuidedPracticeAvoid | null | undefined): GuidedPracticeValidationError[] {
  const out: GuidedPracticeValidationError[] = [];
  const prev = avoid && Array.isArray(avoid.previousExercises) ? avoid.previousExercises.slice(0, GUIDED_PRACTICE_DISTINCT.previousMax) : [];
  if (!prev.length || !isObj(doc) || !Array.isArray((doc as any).exercises)) return out;
  const prevTitles = prev.map((x) => (isObj(x) ? guidedPracticeNormTitle(x.title) : ''));
  ((doc as any).exercises as unknown[]).forEach((e, i) => {
    if (!isObj(e)) return;
    const p = `$.exercises[${i}]`;
    const nt = guidedPracticeNormTitle(e.title);
    const k = nt ? prevTitles.indexOf(nt) : -1;
    if (k >= 0) { out.push({ path: `${p}.title`, code: 'GUIDED_PRACTICE_RUN_DUPLICATE', message: `${p}.title repite un ejercicio guiado de otro capítulo del curso («${prev[k].title}»): usa otra situación y otro título` }); return; }
    const sig = guidedPracticeSignature(e.situation);
    for (const x of prev) {
      if (!isObj(x)) continue;
      const j = guidedPracticeSignatureJaccard(sig, (x as any).sig);
      if (j >= GUIDED_PRACTICE_DISTINCT.situationJaccard) { out.push({ path: `${p}.situation`, code: 'GUIDED_PRACTICE_RUN_DUPLICATE', message: `${p}.situation es casi igual a la de un ejercicio guiado de otro capítulo del curso («${x.title}», similitud ${j.toFixed(2)}): usa otra situación` }); return; }
    }
  });
  return out;
}

/** Normalización de títulos (espejo EXACTO de _dynNormTitle del ejecutor). */
export function guidedPracticeNormTitle(t: unknown): string {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^(practica|taller|caso|ejercicio)[^:]*:\s*/, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fix N1: choque DURO con un caso del módulo (espejo de la parte dura de dynLintGuidedPracticeAvoid): el mismo título de
 * escenario que una práctica o una AA del módulo, o 2+ de sus protagonistas (nombres propios) en el título o la situación.
 */
export function guidedPracticeCaseClashes(doc: unknown, avoid: GuidedPracticeAvoid | null | undefined): GuidedPracticeValidationError[] {
  const out: GuidedPracticeValidationError[] = [];
  if (!avoid || !isObj(doc) || !Array.isArray((doc as any).exercises)) return out;
  const titles: string[] = [...(avoid.practiceChapterTitles || [])];
  const names: string[] = [];
  for (const c of avoid.applicationCases || []) {
    if (!isObj(c)) continue;
    if (c.title) titles.push(c.title);
    if (c.workshopTitle) titles.push(c.workshopTitle);
    for (const n of c.names || []) if (typeof n === 'string' && n.trim() && !names.includes(n)) names.push(n);
  }
  const normTitles = titles.map(guidedPracticeNormTitle).filter(Boolean);
  ((doc as any).exercises as unknown[]).forEach((e, i) => {
    if (!isObj(e)) return;
    const p = `$.exercises[${i}]`;
    const nt = guidedPracticeNormTitle(e.title);
    const text = `${String(e.title || '')}\n${String(e.situation || '')}`;
    const shared = names.filter((n) => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(text));
    if (nt && normTitles.includes(nt)) out.push({ path: `${p}.title`, code: 'GUIDED_PRACTICE_CASE_CLASH', message: `${p}.title repite el escenario de la práctica o de una Actividad de Aplicación del módulo («${e.title}»): usa otra situación` });
    else if (shared.length >= 2) out.push({ path: `${p}.situation`, code: 'GUIDED_PRACTICE_CASE_CLASH', message: `${p}.situation usa a los mismos protagonistas de una Actividad de Aplicación del módulo (${shared.slice(0, 4).join(', ')}): usa otras personas y otra organización` });
  });
  return out;
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
    } else if (ans && taskCount >= L.tasksMin) {
      // Loop 10 C1-c: cada consigna con una respuesta sustantiva (nunca «ver la tabla del capítulo»).
      const segs = guidedPracticeAnswerSegments(ans, taskCount) || [];
      const D = GUIDED_PRACTICE_DISTINCT;
      const thin = segs.map((sg, k) => (sg.length < D.answerSegmentMin || (sg.length < D.answerStubMaxChars && GUIDED_PRACTICE_ANSWER_STUB_RE.test(sg)) ? k + 1 : 0)).filter(Boolean);
      if (thin.length) err(`${p}.modelAnswer`, 'GUIDED_PRACTICE_ANSWER_THIN', `${p}.modelAnswer no responde de verdad la(s) consigna(s) ${thin.join(', ')}: cada respuesta desarrolla el trabajo pedido (al menos ${D.answerSegmentMin} caracteres), nunca remite a otra parte («ver la tabla…»)`);
    }
  });
  // Loop 10 C1-a: ejercicios distintos dentro del documento.
  errors.push(...guidedPracticeDistinctErrors(doc));
  // Fix N1: el choque duro con los casos del módulo lo verifica también el servidor (no solo el ejecutor).
  errors.push(...guidedPracticeCaseClashes(doc, ctx.avoid));
  // Loop 10 C1-b: ni repetir un ejercicio guiado de otro capítulo del run.
  errors.push(...guidedPracticeRunClashes(doc, ctx.avoid));
  return errors;
}

/** Métricas para el output_summary del item (no bloquean). */
export function guidedPracticeSummary(doc: any): Record<string, unknown> {
  const xs = Array.isArray(doc?.exercises) ? doc.exercises : [];
  return {
    exerciseCount: xs.length,
    minutes: doc?.minutes ?? null,
    kinds: xs.map((e: any) => e?.kind ?? null),
    // Loop 10 C1-b: huellas (título + firma de la situación) que los capítulos siguientes del run no repiten.
    fingerprints: guidedPracticeFingerprints(doc),
  };
}
