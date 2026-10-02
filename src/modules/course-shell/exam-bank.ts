/**
 * EV6 P2-B2 — Contrato del banco de preguntas de los exámenes v3
 * (artifact `dynamic_exam_bank_json`, `bankVersion` 1).
 *
 * Todo es PURO y determinístico: el ejecutor del navegador (F1/F2) lo replica
 * EXACTAMENTE (mismas fórmulas, mismo orden, mismas regex literales), así lo
 * que el navegador acepta es lo que el servidor acepta.
 *
 * 1. Plan de slots
 *    - `examSlotSplit(n)`      = `dynExamQuestionSplit` (44-dynamic-prompt-builders.js).
 *    - `finalExamSlotSplit(n)` = `dynFinalExamQuestionSplit` (tope 40).
 *    - `moduleExamPlan(chapterIds)`: hojas {chapterId, type, slots}; por tipo T (orden
 *      multichoice, truefalse, match) y dentro de cada tipo en el orden de capítulos del
 *      Manifest: base = floor(n_T / k); los primeros n_T − base·k capítulos reciben +1.
 *      Las hojas con 0 slots se omiten.
 *    - `finalExamPlan(modules)`: hojas {moduleId, type, slots}; por tipo T y módulo (orden
 *      del Manifest), restos mayores de n_T · c_m / C en aritmética ENTERA
 *      (base = floor(n_T·c_m / C), resto = (n_T·c_m) mod C; el sobrante va a los restos
 *      mayores, empate → módulo anterior). Hojas con 0 slots omitidas.
 *    - `bankFloor(s) = max(s+1, ceil(1.5·s))`, `bankTarget(s) = 2s`, se piden 2s+1, máximo
 *      aceptado 2s+2 por hoja.
 *
 * 2. Esquema (claves exactas: falta → MISSING_FIELD, sobra → UNKNOWN_FIELD; tipo/longitud/
 *    enum/regex → EXAM_BANK_SCHEMA). Longitud de texto = `s.trim().length` (unidades UTF-16).
 *
 * 3. `validateExamBank(doc, ctx)` devuelve TODOS los errores {path, code, message}; nunca
 *    lanza por contenido.
 */
import type { ShellValidationError } from './activity-type';

export const EXAM_BANK_ARTIFACT_TYPE = 'dynamic_exam_bank_json';
export const EXAM_GIFT_ARTIFACT_TYPE = 'dynamic_exam_gift';
export const EXAM_BANK_VERSION = 1;

export const EXAM_QUESTION_TYPES = ['multichoice', 'truefalse', 'match'] as const;
export type ExamQuestionType = (typeof EXAM_QUESTION_TYPES)[number];
export const EXAM_LEVELS = ['recordar', 'comprender', 'aplicar', 'analizar'] as const;
export type ExamLevel = (typeof EXAM_LEVELS)[number];
export type ExamBankScope = 'module' | 'final';

/** Tope del examen final (mismo valor que DYN_FINAL_EXAM_MAX_QUESTIONS del frontend). */
export const FINAL_EXAM_MAX_SLOTS = 40;

/** Límites de texto [min, max] (trim().length). */
export const EXAM_BANK_LIMITS = Object.freeze({
  stem: [20, 600] as const,
  explanation: [60, 700] as const,
  evidence: [40, 220] as const,
  optionText: [1, 200] as const,
  optionWhy: [20, 400] as const,
  whyWrong: [20, 400] as const,
  /** P2-B3 fix 1: el término es la opción del desplegable de Moodle (corta en móvil). */
  term: [1, 60] as const,
  definition: [1, 200] as const,
  pairs: [4, 6] as const,
  distractors: 3,
});

export const EXAM_BANK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * P2-B3 fix 1 (M1): caracteres de control C0 (salvo \t y \n) y DEL — inválidos en XML 1.0 o
 * invisibles; en CUALQUIER texto del banco → EXAM_BANK_SCHEMA. El frontend replica el literal.
 */
export const EXAM_BANK_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
/**
 * P2-B3 fix 1 (I1): el término de un par de emparejamiento es la opción del desplegable de Moodle,
 * que pasa por format_string() → strip_tags (formatstringstriptags = 1): «<5 %» se comería texto.
 * `<` o `>` en `term` → EXAM_BANK_MATCH. El frontend replica el literal.
 */
export const EXAM_MATCH_TERM_FORBIDDEN_RE = /[<>]/;

// ─── 1. Plan de slots ──────────────────────────────────────────────────────

export interface ExamSlotSplit {
  total: number;
  multichoice: number;
  truefalse: number;
  match: number;
}

/** Espejo exacto de `dynExamQuestionSplit` (Math.round de JS, igual en TS). */
export function examSlotSplit(chapterCount: number): ExamSlotSplit {
  const cc = Math.max(1, chapterCount || 0);
  const total = Math.round((cc * 25) / 3);
  const multichoice = Math.round(total * 0.6);
  const truefalse = Math.round(total * 0.2);
  const match = Math.max(0, total - multichoice - truefalse);
  return { total: multichoice + truefalse + match, multichoice, truefalse, match };
}

/** Espejo exacto de `dynFinalExamQuestionSplit` (tope 40). */
export function finalExamSlotSplit(chapterCount: number): ExamSlotSplit {
  const s = examSlotSplit(chapterCount);
  if (s.total <= FINAL_EXAM_MAX_SLOTS) return s;
  const total = FINAL_EXAM_MAX_SLOTS;
  const multichoice = Math.round(total * 0.6);
  const truefalse = Math.round(total * 0.2);
  const match = Math.max(0, total - multichoice - truefalse);
  return { total: multichoice + truefalse + match, multichoice, truefalse, match };
}

export interface ModuleExamLeaf {
  chapterId: string;
  type: ExamQuestionType;
  slots: number;
}
export interface FinalExamLeaf {
  moduleId: string;
  type: ExamQuestionType;
  slots: number;
}
export type ExamPlanLeaf = ModuleExamLeaf | FinalExamLeaf;

/** Plan del examen de módulo: hojas capítulo × tipo (tipo mayor, capítulo menor). */
export function moduleExamPlan(chapterIds: readonly string[]): ModuleExamLeaf[] {
  const k = chapterIds.length;
  if (k === 0) throw new Error('EXAM_BANK_PLAN: un examen de módulo necesita al menos un capítulo');
  const split = examSlotSplit(k);
  const out: ModuleExamLeaf[] = [];
  for (const type of EXAM_QUESTION_TYPES) {
    const n = split[type];
    const base = Math.floor(n / k);
    const extra = n - base * k;
    chapterIds.forEach((chapterId, i) => {
      const slots = base + (i < extra ? 1 : 0);
      if (slots > 0) out.push({ chapterId, type, slots });
    });
  }
  return out;
}

/** Plan del examen final: hojas módulo × tipo, proporcional a los capítulos de cada módulo (restos mayores enteros). */
export function finalExamPlan(modules: ReadonlyArray<{ moduleId: string; chapterIds: readonly string[] }>): FinalExamLeaf[] {
  const C = modules.reduce((a, m) => a + m.chapterIds.length, 0);
  if (C === 0) throw new Error('EXAM_BANK_PLAN: un examen final necesita al menos un capítulo');
  const split = finalExamSlotSplit(C);
  const out: FinalExamLeaf[] = [];
  for (const type of EXAM_QUESTION_TYPES) {
    const n = split[type];
    const rows = modules.map((m, i) => {
      const q = n * m.chapterIds.length;
      return { i, base: Math.floor(q / C), rem: q % C };
    });
    let left = n - rows.reduce((a, r) => a + r.base, 0);
    const order = [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i);
    const extra = new Set<number>();
    for (const r of order) {
      if (left <= 0) break;
      extra.add(r.i);
      left--;
    }
    modules.forEach((m, i) => {
      const slots = rows[i].base + (extra.has(i) ? 1 : 0);
      if (slots > 0) out.push({ moduleId: m.moduleId, type, slots });
    });
  }
  return out;
}

export function bankFloor(slots: number): number {
  return Math.max(slots + 1, Math.ceil(1.5 * slots));
}
export function bankTarget(slots: number): number {
  return 2 * slots;
}
/** Preguntas que pide la generación por hoja. */
export function bankRequested(slots: number): number {
  return 2 * slots + 1;
}
/** Máximo aceptado por hoja. */
export function bankMax(slots: number): number {
  return 2 * slots + 2;
}
/**
 * BANKOPT: lo que el ejecutor del navegador PIDE al LLM por hoja (espejo de dynExamBankAskCount, 44):
 * holgura dentro de bankMax — selección múltiple 2s+2, V/F y emparejamiento 2s+1. El banco subido sigue
 * conservando bankTarget (2s) por hoja; esto solo dimensiona el costo (estimador, run-budget.ts).
 */
export function bankAskCount(slots: number, type: ExamQuestionType): number {
  return 2 * slots + (type === 'multichoice' ? 2 : 1);
}
export function planSlotCount(plan: readonly ExamPlanLeaf[]): number {
  return plan.reduce((a, l) => a + l.slots, 0);
}

/**
 * Plan esperado de un examen según el Manifest: scope module → `moduleExamPlan` de los
 * capítulos del módulo; scope final → `finalExamPlan` de los módulos (orden del Manifest,
 * agrupando `chapters` por moduleId en orden de primera aparición).
 */
export function expectedExamPlan(scope: ExamBankScope, chapters: ReadonlyArray<{ id: string; moduleId: string }>): ExamPlanLeaf[] {
  if (scope === 'module') return moduleExamPlan(chapters.map((c) => c.id));
  const mods: Array<{ moduleId: string; chapterIds: string[] }> = [];
  for (const c of chapters) {
    let m = mods.find((x) => x.moduleId === c.moduleId);
    if (!m) {
      m = { moduleId: c.moduleId, chapterIds: [] };
      mods.push(m);
    }
    m.chapterIds.push(c.id);
  }
  return finalExamPlan(mods);
}

// ─── Normalización (F2 la replica byte a byte) ──────────────────────────────

/**
 * Normalización de texto del contrato (evidencia, duplicados, lints). Pasos, EN ESTE ORDEN:
 *  1. `normalize('NFD')` y quitar U+0300–U+036F (diacríticos); minúsculas.
 *  2. Quitar invisibles: U+00AD (guion blando), U+200B–U+200D, U+2060, U+FEFF.
 *  3. Por línea, quitar la viñeta inicial (con citas `>` delante):
 *     `^[ \t>]*(?:[-+*•‣◦▪]|\d{1,3}[.)])[ \t]+` (flag m; •‣◦▪ = U+2022 U+2023 U+25E6 U+25AA).
 *  4. Quitar los caracteres de Markdown `* _ # > \` [ ] ( ) |`.
 *  5. Plegar tipografía: «»“”„‟″ → `"`; ‘’‚‛′‹› → `'`; ‐‑‒–—―− → `-`; … → `...`.
 *  6. Colapsar `\s+` (incluye NBSP U+00A0, U+202F, U+2007…) a un espacio; trim.
 */
export function normalizeExamText(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/^[ \t>]*(?:[-+*\u2022\u2023\u25e6\u25aa]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/[*_#>`[\]()|]/g, '')
    .replace(/[\u00ab\u00bb\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2039\u203a]/g, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens de un texto ya normalizado: números con separadores decimales/miles como UN token; palabras. */
export const EXAM_TOKEN_RE = /\p{N}+(?:[.,]\p{N}+)*|\p{L}+/gu;
export function examTokens(normalized: string): string[] {
  return normalized.match(EXAM_TOKEN_RE) ?? [];
}

/**
 * BANKOPT fix rounds 3-4 — la evidencia respalda lo que el capítulo AFIRMA (guardia de oración).
 * Un fragmento textual no prueba la afirmación de la pregunta si su oración:
 *  - es una pregunta (lleva ? o ¿) -> 'question';
 *  - lo niega antes («No [frag]», «Nunca…», «ni», «sin», «nadie»…) o lo declara falso alrededor
 *    («es falso que», «no es cierto», «es un mito», «es mentira») -> 'negated';
 *  - lo condiciona o exceptúa antes («Si…», «Excepto…», «Salvo…», «Solo con…», «A menos que…») o después
 *    («…, excepto», «salvo», «si», «cuando», «mientras», «sino», «pero», «aunque», «solo si», «siempre que»…)
 *    -> 'conditioned'.
 * Mitigaciones de falsos rechazos (fix round 4, R3): el límite de oración admite comillas de cierre; «:» y
 * «;» acotan el examen del prefijo; «si» con verificar/revisar/comprobar/detectar/observar/preguntar/saber/
 * decidir en los 3 tokens anteriores es «si» interrogativo (no condición); «sí» con tilde nunca es condición (se conserva la tilde para
 * este chequeo); «sin embargo», «no obstante» y «no solo… sino también» no niegan.
 * Normalización: `normalizeExamText` por LÍNEA (unidas con un espacio) tras marcar «sí» con tilde; límites de
 * oración = líneas y . ! ? seguidos de comillas opcionales y de espacio o fin. Basta UNA aparición válida.
 * Espejo byte a byte en el ejecutor (45: dynExamEvidenceSupport).
 */
export const EXAM_EVIDENCE_PREFIX_NEGATIONS: readonly string[] = ['no', 'nunca', 'jamas', 'ni', 'sin', 'tampoco', 'nadie', 'nada', 'ninguno', 'ninguna', 'ningun', 'ningunos', 'ningunas'];
export const EXAM_EVIDENCE_FALSITY_PHRASES: readonly string[] = ['es falso', 'no es cierto', 'no es verdad', 'es un mito', 'es mentira'];
export const EXAM_EVIDENCE_PREFIX_CONDITIONS: readonly string[] = ['si', 'excepto', 'salvo'];
export const EXAM_EVIDENCE_PREFIX_CONDITION_PAIRS: readonly string[] = ['a menos', 'solo con', 'solamente con', 'unicamente con', 'solo si', 'solo cuando', 'siempre que', 'en caso', 'con tal'];
export const EXAM_EVIDENCE_SUFFIX_CONDITIONS: readonly string[] = ['excepto', 'salvo', 'si', 'cuando', 'mientras', 'sino', 'pero', 'aunque'];
export const EXAM_EVIDENCE_SUFFIX_CONDITION_PAIRS: readonly string[] = ['a menos', 'siempre que', 'siempre y', 'solo si', 'solo cuando', 'solamente si', 'solamente cuando', 'unicamente si', 'unicamente cuando', 'hasta que', 'con tal', 'en caso', 'a no'];
/** Raíces de verbos tras los que «si» es interrogativo («verifica si…», «revisa si…»). */
export const EXAM_EVIDENCE_WHETHER_VERBS: readonly string[] = ['verific', 'revis', 'comprob', 'comprueb', 'detect', 'observ', 'pregunt', 'sab', 'decid'];
const EXAM_SI_ACCENT_RE = /(^|[^\p{L}\p{N}])([sS])[íÍ](?![\p{L}\p{N}])/gu;
export function examGuardNormalize(s: string): string {
  return normalizeExamText(String(s ?? '').replace(EXAM_SI_ACCENT_RE, '$1$2itilde'));
}
export type ExamEvidenceSupport = { ok: true } | { ok: false; reason: 'missing' | 'negated' | 'conditioned' | 'question' };
export interface ExamEvidenceIndex { norm: string; bounds: number[] }
export function examEvidenceIndex(chapterMd: string): ExamEvidenceIndex {
  let norm = '';
  const bounds: number[] = [0];
  for (const line of String(chapterMd ?? '').split('\n')) {
    const n = examGuardNormalize(line);
    if (!n) continue;
    if (norm) norm += ' ';
    const start = norm.length;
    bounds.push(start);
    norm += n;
    const re = /[.!?]+["']*(?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(n))) bounds.push(start + m.index + m[0].length);
    bounds.push(norm.length);
  }
  bounds.sort((a, b) => a - b);
  return { norm, bounds };
}
function examIsWhetherVerb(t: string | undefined): boolean {
  return typeof t === 'string' && EXAM_EVIDENCE_WHETHER_VERBS.some((v) => t.startsWith(v));
}
/** «si» interrogativo: uno de los 3 tokens anteriores es un verbo de averiguar («pregunta al cliente si…»). */
function examWhetherBefore(tokens: readonly string[]): boolean {
  return tokens.slice(-3).some(examIsWhetherVerb);
}
function examHasPhrase(tokens: readonly string[], phrases: readonly string[]): boolean {
  const s = ' ' + tokens.join(' ') + ' ';
  return phrases.some((p) => s.includes(' ' + p + ' '));
}
export function examEvidenceSupport(chapter: string | ExamEvidenceIndex, evidence: string): ExamEvidenceSupport {
  const ev = examGuardNormalize(evidence);
  if (!ev) return { ok: false, reason: 'missing' };
  const { norm, bounds } = typeof chapter === 'string' ? examEvidenceIndex(chapter) : chapter;
  const evTok = examTokens(ev);
  let found = false;
  let reason: 'negated' | 'conditioned' | 'question' = 'negated';
  for (let at = norm.indexOf(ev); at >= 0; at = norm.indexOf(ev, at + 1)) {
    found = true;
    const end = at + ev.length;
    let sStart = 0;
    let sEnd = norm.length;
    for (const b of bounds) { if (b <= at && b > sStart) sStart = b; if (b >= end && b < sEnd) sEnd = b; }
    // Pregunta: ? o ¿ en la oración FUERA de citas entre comillas (una pregunta citada en una afirmación no cuenta).
    if (/[?¿]/.test(norm.slice(sStart, sEnd).replace(/"[^"]*"|'[^']*'/g, ''))) { reason = 'question'; continue; }
    const preText = norm.slice(sStart, at);
    const cut = Math.max(preText.lastIndexOf(':'), preText.lastIndexOf(';'));
    const pre = examTokens(cut >= 0 ? preText.slice(cut + 1) : preText);
    const post = examTokens(norm.slice(end, sEnd));
    const next = (i: number): string | undefined => (i + 1 < pre.length ? pre[i + 1] : evTok[0]);
    const negated = pre.some((t, i) => EXAM_EVIDENCE_PREFIX_NEGATIONS.includes(t)
      && !(t === 'sin' && next(i) === 'embargo')
      && !(t === 'no' && ['obstante', 'solo', 'solamente', 'unicamente'].includes(next(i) as string)));
    if (negated || examHasPhrase(pre, EXAM_EVIDENCE_FALSITY_PHRASES) || examHasPhrase(post, EXAM_EVIDENCE_FALSITY_PHRASES)) { reason = 'negated'; continue; }
    const preCond = pre.some((t, i) => EXAM_EVIDENCE_PREFIX_CONDITIONS.includes(t) && !(t === 'si' && examWhetherBefore(pre.slice(0, i))))
      || examHasPhrase(pre, EXAM_EVIDENCE_PREFIX_CONDITION_PAIRS);
    const postCond = post.some((t, i) => EXAM_EVIDENCE_SUFFIX_CONDITIONS.includes(t)
      && !(t === 'si' && examWhetherBefore(evTok.concat(post.slice(0, i))))
      && !(t === 'sino' && post[i + 1] === 'tambien'))
      || examHasPhrase(post, EXAM_EVIDENCE_SUFFIX_CONDITION_PAIRS);
    if (preCond || postCond) { reason = 'conditioned'; continue; }
    return { ok: true };
  }
  return found ? { ok: false, reason } : { ok: false, reason: 'missing' };
}

/**
 * ¿`inner` está contenido en `outer` por palabras completas? (secuencia contigua de tokens;
 * «5 mg/L» NO está en «15 mg/L», «2 horas» NO está en «12 horas», «agua» SÍ está en «agua tibia»).
 * Ambos se normalizan con `normalizeExamText`; un texto sin tokens nunca está contenido.
 */
export function examTextContains(outer: string, inner: string): boolean {
  const o = examTokens(normalizeExamText(outer));
  const i = examTokens(normalizeExamText(inner));
  if (i.length === 0 || i.length > o.length) return false;
  for (let k = 0; k + i.length <= o.length; k++) {
    let ok = true;
    for (let j = 0; j < i.length; j++) {
      if (o[k + j] !== i[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Opciones prohibidas (Moodle baraja las opciones). Se aplica sobre `normalizeExamText(option)`
 * (sin acentos, minúsculas) y está ANCLADA a la opción completa (fix 2): «Revisar todas las opciones
 * de filtrado» o «vitamina a y e son correctas» no se marcan. Byte-idéntica en el frontend.
 */
export const EXAM_OPTION_FORBIDDEN_RE =
  /^(?:(?:todas|ninguna|ambas) (?:de )?(?:las |los )?(?:otras |otros |demas )?(?:anteriores|opciones|respuestas|alternativas|demas)(?: anteriores)?(?: (?:son|es) (?:correctas?|incorrectas?|validas?))?|(?:todas|ambas|ninguna) (?:son|es) (?:correctas?|incorrectas?|validas?)|[a-e] y [a-e] (?:son )?correctas?)[.!]?$/;

// ─── Tipos del documento ────────────────────────────────────────────────────

export interface ExamOption {
  text: string;
  why: string;
}
interface ExamQuestionBase {
  id: string;
  chapterId: string;
  moduleId?: string;
  level: ExamLevel;
  stem: string;
  explanation: string;
  evidence: string;
}
export interface ExamMultichoiceQuestion extends ExamQuestionBase {
  type: 'multichoice';
  correct: ExamOption;
  distractors: ExamOption[];
}
export interface ExamTrueFalseQuestion extends ExamQuestionBase {
  type: 'truefalse';
  answer: boolean;
  whyWrong: string;
}
export interface ExamMatchQuestion extends ExamQuestionBase {
  type: 'match';
  pairs: Array<{ term: string; definition: string }>;
}
export type ExamBankQuestion = ExamMultichoiceQuestion | ExamTrueFalseQuestion | ExamMatchQuestion;

/**
 * BANKOPT fix round 4 (R2): versión de las reglas de validación con que se ACEPTÓ el banco.
 *  1 (o ausente) = evidencia textual por subcadena (bancos anteriores);
 *  2 = además la oración debe AFIRMAR la evidencia (examEvidenceSupport).
 * completeItem valida SIEMPRE con las reglas vigentes; el empaque re-valida con las de la versión del banco
 * (un banco ya aceptado nunca deja de empaquetarse porque las reglas se endurecieron).
 */
export const EXAM_BANK_VALIDATION_VERSION = 2;
export interface ExamBankV1 {
  bankVersion: 1;
  bankValidationVersion?: 1 | 2;
  scope: ExamBankScope;
  moduleId: string | null;
  plan: ExamPlanLeaf[];
  questions: ExamBankQuestion[];
}


export interface ExamBankValidationContext {
  scope: ExamBankScope;
  /** Capítulos ACTUALES del examen en orden del Manifest, con su módulo (exam: los del módulo; final: todos). */
  chapters: ReadonlyArray<{ id: string; moduleId: string }>;
  /** Markdown de cada capítulo (completeItem lee el dynamic_content_md vigente; el empaque también). */
  chapterMd?: ReadonlyMap<string, string>;
  /**
   * Origen del plan esperado:
   *  - 'manifest' (default, completeItem): `doc.plan` debe ser EXACTAMENTE `expectedExamPlan(scope, chapters)`.
   *  - 'frozen' (empaque, C2): se usa el plan CONGELADO del banco (bien formado) + pertenencia:
   *    exam → cada capítulo del plan existe y sigue en el módulo del banco; final → cada módulo
   *    del plan existe. Un reorden (capítulos dentro del módulo, módulos) no invalida el banco.
   */
  planSource?: 'manifest' | 'frozen';
  /**
   * Reglas de evidencia (fix round 4, R2): 'current' (default, completeItem) = las vigentes
   * (EXAM_BANK_VALIDATION_VERSION); 'asAccepted' (empaque) = las de `doc.bankValidationVersion` (ausente = 1).
   */
  evidenceRules?: 'current' | 'asAccepted';
}

export interface ExamBankValidationResult {
  ok: boolean;
  errors: ShellValidationError[];
  /** Slots del plan usado (= preguntas que ve el estudiante). */
  slotCount: number;
  /** Preguntas del banco (0 si el documento no es legible). */
  bankSize: number;
  /** Plan usado para validar (el del Manifest o el congelado; null si el congelado es inválido). */
  plan: ExamPlanLeaf[] | null;
}
// ─── 3. Validación ──────────────────────────────────────────────────────────

const TOP_KEYS = ['bankVersion', 'bankValidationVersion', 'scope', 'moduleId', 'plan', 'questions'];
const COMMON_KEYS = ['id', 'type', 'chapterId', 'level', 'stem', 'explanation', 'evidence'];
const TYPE_KEYS: Record<ExamQuestionType, string[]> = {
  multichoice: ['correct', 'distractors'],
  truefalse: ['answer', 'whyWrong'],
  match: ['pairs'],
};

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function len(s: string): number {
  return s.trim().length;
}

class Errs {
  readonly list: ShellValidationError[] = [];
  push(path: string, code: string, message: string): void {
    this.list.push({ path, code, message });
  }
  /** Claves exactas: faltantes → MISSING_FIELD, sobrantes → UNKNOWN_FIELD. Devuelve true si están todas las requeridas. */
  keys(obj: Record<string, unknown>, allowed: string[], path: string): boolean {
    let ok = true;
    for (const k of allowed) {
      if (!(k in obj)) {
        this.push(`${path}.${k}`, 'MISSING_FIELD', `falta el campo "${k}"`);
        ok = false;
      }
    }
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.push(`${path}.${k}`, 'UNKNOWN_FIELD', `campo no permitido "${k}"`);
    return ok;
  }
  /** Texto con longitud [min, max]; devuelve el texto si es string. */
  text(v: unknown, path: string, [min, max]: readonly [number, number]): string | null {
    if (v === undefined) return null; // MISSING_FIELD ya reportado por keys()
    if (typeof v !== 'string') {
      this.push(path, 'EXAM_BANK_SCHEMA', 'se esperaba texto');
      return null;
    }
    const n = len(v);
    if (n < min || n > max) this.push(path, 'EXAM_BANK_SCHEMA', `longitud ${n} fuera de ${min}–${max}`);
    if (EXAM_BANK_CONTROL_RE.test(v)) this.push(path, 'EXAM_BANK_SCHEMA', 'caracteres de control no permitidos (solo \\t y \\n)');
    return v;
  }
  option(v: unknown, path: string): ExamOption | null {
    if (v === undefined) return null;
    if (!isObj(v)) {
      this.push(path, 'EXAM_BANK_SCHEMA', 'se esperaba un objeto {text, why}');
      return null;
    }
    this.keys(v, ['text', 'why'], path);
    const text = this.text(v.text, `${path}.text`, EXAM_BANK_LIMITS.optionText);
    this.text(v.why, `${path}.why`, EXAM_BANK_LIMITS.optionWhy);
    return text === null ? null : { text, why: typeof v.why === 'string' ? v.why : '' };
  }
}

function sameLeaf(a: Record<string, unknown>, b: ExamPlanLeaf): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === (b as any)[k]);
}


/**
 * Plan congelado del banco bien formado: lista no vacía de hojas con las claves exactas del scope,
 * tipo válido, slots entero ≥ 1, sin hojas repetidas (dueño × tipo). null si no.
 */
export function wellFormedFrozenPlan(plan: unknown, scope: ExamBankScope): ExamPlanLeaf[] | null {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  const ownerKey = scope === 'module' ? 'chapterId' : 'moduleId';
  const seen = new Set<string>();
  for (const l of plan) {
    if (!isObj(l)) return null;
    const keys = Object.keys(l).sort();
    if (keys.join(',') !== [ownerKey, 'slots', 'type'].sort().join(',')) return null;
    if (typeof l[ownerKey] !== 'string' || !l[ownerKey]) return null;
    if (!(EXAM_QUESTION_TYPES as readonly string[]).includes(l.type)) return null;
    if (!Number.isInteger(l.slots) || l.slots < 1) return null;
    const k = `${l[ownerKey]}\u0000${l.type}`;
    if (seen.has(k)) return null;
    seen.add(k);
  }
  return plan.map((l) => ({ ...l })) as ExamPlanLeaf[];
}

/**
 * Valida un banco `dynamic_exam_bank_json` contra el contexto del examen.
 * Códigos: MISSING_FIELD, UNKNOWN_FIELD, EXAM_BANK_SCHEMA, EXAM_BANK_PLAN,
 * EXAM_BANK_LEAF_COUNT, EXAM_BANK_DUPLICATE, EXAM_BANK_LENGTH_BIAS,
 * EXAM_BANK_OPTION_LINT, EXAM_BANK_TF_BALANCE, EXAM_BANK_MATCH, EXAM_BANK_EVIDENCE.
 * Los mensajes de errores por pregunta o de banco citan los `id` de las preguntas.
 * Lanza SOLO si el contexto es inválido (bug de integración, no contenido).
 */
export function validateExamBank(doc: unknown, ctx: ExamBankValidationContext): ExamBankValidationResult {
  if (ctx.scope !== 'module' && ctx.scope !== 'final') throw new Error(`EXAM_BANK_CONTEXT: scope inválido ${String(ctx.scope)}`);
  if (!ctx.chapters?.length) throw new Error('EXAM_BANK_CONTEXT: el examen no tiene capítulos');
  const frozen = ctx.planSource === 'frozen';
  const E = new Errs();
  const chapterModule = new Map(ctx.chapters.map((c) => [c.id, c.moduleId]));
  const examModule = ctx.scope === 'module' ? ctx.chapters[0].moduleId : null;

  // Plan de referencia: el del Manifest (completeItem) o el congelado del banco (empaque).
  let plan: ExamPlanLeaf[] | null = frozen ? null : expectedExamPlan(ctx.scope, ctx.chapters);
  if (frozen && isObj(doc)) {
    plan = wellFormedFrozenPlan(doc.plan, ctx.scope);
    if (!plan && doc.plan !== undefined) E.push('$.plan', 'EXAM_BANK_PLAN', 'el plan congelado del banco no está bien formado');
    if (plan) {
      const currentModules = new Set(ctx.chapters.map((c) => c.moduleId));
      for (const l of plan) {
        if ('chapterId' in l) {
          if (chapterModule.get(l.chapterId) !== examModule) {
            E.push('$.plan', 'EXAM_BANK_PLAN', `el capítulo ${l.chapterId} del plan congelado ya no existe o ya no pertenece al módulo ${examModule}`);
          }
        } else if (!currentModules.has(l.moduleId)) {
          E.push('$.plan', 'EXAM_BANK_PLAN', `el módulo ${l.moduleId} del plan congelado ya no existe en el curso`);
        }
      }
    }
  }
  const slotCount = plan ? planSlotCount(plan) : 0;
  const done = (bankSize: number): ExamBankValidationResult => ({ ok: E.list.length === 0, errors: E.list, slotCount, bankSize, plan });

  if (!isObj(doc)) {
    E.push('$', 'EXAM_BANK_SCHEMA', 'el banco debe ser un objeto JSON');
    return done(0);
  }
  // bankValidationVersion es OPCIONAL (bancos anteriores no lo traen): solo se exige si está.
  E.keys(doc, 'bankValidationVersion' in doc ? TOP_KEYS : TOP_KEYS.filter((k) => k !== 'bankValidationVersion'), '$');
  if (doc.bankVersion !== undefined && doc.bankVersion !== EXAM_BANK_VERSION) E.push('$.bankVersion', 'EXAM_BANK_SCHEMA', `bankVersion debe ser ${EXAM_BANK_VERSION}`);
  if (doc.bankValidationVersion !== undefined && !(Number.isInteger(doc.bankValidationVersion) && doc.bankValidationVersion >= 1 && doc.bankValidationVersion <= EXAM_BANK_VALIDATION_VERSION)) {
    E.push('$.bankValidationVersion', 'EXAM_BANK_SCHEMA', `bankValidationVersion debe ser un entero de 1 a ${EXAM_BANK_VALIDATION_VERSION}`);
  }
  if (doc.scope !== undefined && doc.scope !== ctx.scope) E.push('$.scope', 'EXAM_BANK_SCHEMA', `scope debe ser "${ctx.scope}"`);
  if ('moduleId' in doc) {
    if (ctx.scope === 'module') {
      if (doc.moduleId !== examModule) E.push('$.moduleId', 'EXAM_BANK_SCHEMA', `moduleId debe ser "${examModule}"`);
    } else if (doc.moduleId !== null) {
      E.push('$.moduleId', 'EXAM_BANK_SCHEMA', 'moduleId debe ser null en el examen final');
    }
  }
  if (!frozen && doc.plan !== undefined) {
    const p = doc.plan;
    const exp = plan as ExamPlanLeaf[];
    const same = Array.isArray(p) && p.length === exp.length && p.every((l, i) => isObj(l) && sameLeaf(l, exp[i]));
    if (!same) E.push('$.plan', 'EXAM_BANK_PLAN', `el plan no coincide con el del Manifest (${JSON.stringify(exp)})`);
  }
  const planModules = new Set((plan ?? []).filter((l): l is FinalExamLeaf => 'moduleId' in l).map((l) => l.moduleId));

  if (doc.questions === undefined) return done(0);
  if (!Array.isArray(doc.questions)) {
    E.push('$.questions', 'EXAM_BANK_SCHEMA', 'questions debe ser una lista');
    return done(0);
  }
  const questions: unknown[] = doc.questions;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const idOf = (q: Record<string, any>, i: number): string => (typeof q.id === 'string' && q.id ? q.id : `#${i}`);

  // ── Esquema por pregunta ──
  const valid: Array<{ q: Record<string, any>; i: number; type: ExamQuestionType | null }> = [];
  questions.forEach((q, i) => {
    const path = `$.questions[${i}]`;
    if (!isObj(q)) {
      E.push(path, 'EXAM_BANK_SCHEMA', 'cada pregunta debe ser un objeto');
      return;
    }
    const type = (EXAM_QUESTION_TYPES as readonly string[]).includes(q.type) ? (q.type as ExamQuestionType) : null;
    if (q.type !== undefined && !type) E.push(`${path}.type`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: type debe ser ${EXAM_QUESTION_TYPES.join('|')}`);
    const allowed = [...COMMON_KEYS, ...(ctx.scope === 'final' ? ['moduleId'] : []), ...(type ? TYPE_KEYS[type] : [])];
    E.keys(q, allowed, path);
    if (q.id !== undefined && (typeof q.id !== 'string' || !EXAM_BANK_ID_RE.test(q.id))) E.push(`${path}.id`, 'EXAM_BANK_SCHEMA', 'id debe cumplir /^[A-Za-z0-9_-]{1,40}$/');
    if (q.chapterId !== undefined && (typeof q.chapterId !== 'string' || !chapterModule.has(q.chapterId))) {
      E.push(`${path}.chapterId`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: chapterId no es un capítulo de este examen`);
    }
    if (ctx.scope === 'final' && q.moduleId !== undefined) {
      if (frozen) {
        // C2: el módulo declarado es el de la hoja congelada (el capítulo pudo cambiar de módulo después).
        if (typeof q.moduleId !== 'string' || !planModules.has(q.moduleId)) {
          E.push(`${path}.moduleId`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: moduleId no es un módulo del plan congelado`);
        }
      } else if (typeof q.chapterId === 'string' && chapterModule.has(q.chapterId) && q.moduleId !== chapterModule.get(q.chapterId)) {
        E.push(`${path}.moduleId`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: moduleId debe ser el módulo del capítulo ("${chapterModule.get(q.chapterId)}")`);
      }
    }
    if (q.level !== undefined && !(EXAM_LEVELS as readonly string[]).includes(q.level)) E.push(`${path}.level`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: level debe ser ${EXAM_LEVELS.join('|')}`);
    E.text(q.stem, `${path}.stem`, EXAM_BANK_LIMITS.stem);
    E.text(q.explanation, `${path}.explanation`, EXAM_BANK_LIMITS.explanation);
    E.text(q.evidence, `${path}.evidence`, EXAM_BANK_LIMITS.evidence);
    if (type === 'multichoice') {
      E.option(q.correct, `${path}.correct`);
      if (q.distractors !== undefined) {
        if (!Array.isArray(q.distractors) || q.distractors.length !== EXAM_BANK_LIMITS.distractors) {
          E.push(`${path}.distractors`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: se esperaban exactamente ${EXAM_BANK_LIMITS.distractors} distractores`);
        } else q.distractors.forEach((d: unknown, j: number) => E.option(d, `${path}.distractors[${j}]`));
      }
    } else if (type === 'truefalse') {
      if (q.answer !== undefined && typeof q.answer !== 'boolean') E.push(`${path}.answer`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: answer debe ser booleano`);
      E.text(q.whyWrong, `${path}.whyWrong`, EXAM_BANK_LIMITS.whyWrong);
    } else if (type === 'match') {
      if (q.pairs !== undefined) {
        const [pmin, pmax] = EXAM_BANK_LIMITS.pairs;
        if (!Array.isArray(q.pairs) || q.pairs.length < pmin || q.pairs.length > pmax) {
          E.push(`${path}.pairs`, 'EXAM_BANK_SCHEMA', `${idOf(q, i)}: se esperaban ${pmin}–${pmax} pares`);
        } else {
          q.pairs.forEach((p: unknown, j: number) => {
            const pp = `${path}.pairs[${j}]`;
            if (!isObj(p)) return E.push(pp, 'EXAM_BANK_SCHEMA', 'cada par debe ser {term, definition}');
            E.keys(p, ['term', 'definition'], pp);
            E.text(p.term, `${pp}.term`, EXAM_BANK_LIMITS.term);
            E.text(p.definition, `${pp}.definition`, EXAM_BANK_LIMITS.definition);
          });
        }
      }
    }
    valid.push({ q, i, type });
  });

  // ── Duplicados (id, enunciado normalizado) ──
  const seenId = new Map<string, number>();
  const seenStem = new Map<string, string>();
  for (const { q, i } of valid) {
    if (typeof q.id === 'string') {
      if (seenId.has(q.id)) E.push(`$.questions[${i}].id`, 'EXAM_BANK_DUPLICATE', `id "${q.id}" repetido (preguntas ${seenId.get(q.id)} y ${i})`);
      else seenId.set(q.id, i);
    }
    const ns = normalizeExamText(str(q.stem));
    if (ns) {
      if (seenStem.has(ns)) E.push(`$.questions[${i}].stem`, 'EXAM_BANK_DUPLICATE', `${idOf(q, i)}: enunciado repetido de ${seenStem.get(ns)}`);
      else seenStem.set(ns, idOf(q, i));
    }
  }

  // ── Conteo por hoja ──
  const leafKey = (owner: string, type: string) => `${owner}\u0000${type}`;
  const ownerOf = (q: Record<string, any>): string | null => {
    if (typeof q.chapterId !== 'string' || !chapterModule.has(q.chapterId)) return null;
    if (ctx.scope === 'module') return q.chapterId;
    if (frozen) return typeof q.moduleId === 'string' && planModules.has(q.moduleId) ? q.moduleId : null;
    return chapterModule.get(q.chapterId) as string;
  };
  const byLeaf = new Map<string, string[]>();
  for (const { q, i, type } of valid) {
    const owner = ownerOf(q);
    if (!owner || !type) continue;
    const k = leafKey(owner, type);
    byLeaf.set(k, [...(byLeaf.get(k) ?? []), idOf(q, i)]);
  }
  if (plan) {
    const planned = new Set<string>();
    for (const leaf of plan) {
      const owner = 'chapterId' in leaf ? leaf.chapterId : leaf.moduleId;
      const k = leafKey(owner, leaf.type);
      planned.add(k);
      const n = byLeaf.get(k)?.length ?? 0;
      const min = bankFloor(leaf.slots);
      const max = bankMax(leaf.slots);
      if (n < min || n > max) {
        E.push('$.questions', 'EXAM_BANK_LEAF_COUNT', `${owner} × ${leaf.type}: ${n} preguntas, se esperaban ${min}–${max} (slots ${leaf.slots})`);
      }
    }
    for (const [k, ids] of byLeaf) {
      if (!planned.has(k)) {
        const [owner, type] = k.split('\u0000');
        E.push('$.questions', 'EXAM_BANK_LEAF_COUNT', `${owner} × ${type}: ${ids.length} preguntas fuera del plan (${ids.join(', ')})`);
      }
    }
  }

  // ── Selección múltiple: sesgo de longitud + lint de opciones ──
  let mcTotal = 0;
  const longestIds: string[] = [];
  for (const { q, i, type } of valid) {
    if (type !== 'multichoice') continue;
    if (!isObj(q.correct) || typeof q.correct.text !== 'string' || !Array.isArray(q.distractors)) continue;
    const distractors = q.distractors.filter((d: unknown) => isObj(d) && typeof (d as any).text === 'string') as ExamOption[];
    if (distractors.length !== q.distractors.length || distractors.length === 0) continue;
    const path = `$.questions[${i}]`;
    const id = idOf(q, i);
    const c = len(q.correct.text);
    const longestD = Math.max(...distractors.map((d) => len(d.text)));
    mcTotal++;
    if (c > longestD) longestIds.push(id);
    if (c - longestD >= 8 && 100 * (c - longestD) >= 15 * longestD) {
      E.push(`${path}.correct.text`, 'EXAM_BANK_LENGTH_BIAS', `${id}: la correcta (${c}) supera al distractor más largo (${longestD}) por ≥ 8 caracteres y ≥ 15 %`);
    }
    const options = [q.correct.text, ...distractors.map((d) => d.text)];
    options.forEach((t, j) => {
      if (EXAM_OPTION_FORBIDDEN_RE.test(normalizeExamText(t))) {
        E.push(j === 0 ? `${path}.correct.text` : `${path}.distractors[${j - 1}].text`, 'EXAM_BANK_OPTION_LINT', `${id}: opción del tipo «todas/ninguna de las anteriores»`);
      }
    });
    const norm = options.map(normalizeExamText);
    for (let a = 0; a < options.length; a++) {
      for (let b = a + 1; b < options.length; b++) {
        if (!norm[a] || !norm[b]) continue;
        if (norm[a] === norm[b] || examTextContains(options[a], options[b]) || examTextContains(options[b], options[a])) {
          E.push(path, 'EXAM_BANK_OPTION_LINT', `${id}: las opciones ${a} y ${b} son iguales o una contiene a la otra (palabras completas)`);
        }
      }
    }
  }
  if (mcTotal > 0 && 10 * longestIds.length > 3 * mcTotal) {
    E.push('$.questions', 'EXAM_BANK_LENGTH_BIAS', `la correcta es la opción más larga en ${longestIds.length}/${mcTotal} preguntas (> 30 %): ${longestIds.join(', ')}`);
  }

  // ── Verdadero/falso: balance por hoja (capítulo en módulo, módulo en final) ──
  const tf = new Map<string, { t: string[]; f: string[] }>();
  for (const { q, i, type } of valid) {
    if (type !== 'truefalse' || typeof q.answer !== 'boolean') continue;
    const owner = ownerOf(q);
    if (!owner) continue;
    const s = tf.get(owner) ?? { t: [], f: [] };
    (q.answer ? s.t : s.f).push(idOf(q, i));
    tf.set(owner, s);
  }
  for (const [owner, { t: ts, f: fs }] of tf) {
    const t = ts.length;
    const n = t + fs.length;
    if (n >= 4 && (5 * t < 2 * n || 5 * t > 3 * n)) {
      E.push('$.questions', 'EXAM_BANK_TF_BALANCE', `${owner}: ${t}/${n} verdaderas (fuera de 40–60 %); verdaderas: ${ts.join(', ') || '—'}; falsas: ${fs.join(', ') || '—'}`);
    } else if (n >= 2 && n <= 3 && (t === 0 || t === n)) {
      E.push('$.questions', 'EXAM_BANK_TF_BALANCE', `${owner}: ${n} preguntas V/F todas ${t ? 'verdaderas' : 'falsas'} (${[...ts, ...fs].join(', ')})`);
    }
  }

  // ── Emparejamiento ──
  for (const { q, i, type } of valid) {
    if (type !== 'match' || !Array.isArray(q.pairs)) continue;
    const id = idOf(q, i);
    const pairs = q.pairs.filter((p: unknown) => isObj(p) && typeof (p as any).term === 'string' && typeof (p as any).definition === 'string');
    const terms = pairs.map((p: any) => normalizeExamText(p.term));
    const defs = pairs.map((p: any) => normalizeExamText(p.definition));
    if (new Set(terms).size !== terms.length) E.push(`$.questions[${i}].pairs`, 'EXAM_BANK_MATCH', `${id}: términos repetidos`);
    if (new Set(defs).size !== defs.length) E.push(`$.questions[${i}].pairs`, 'EXAM_BANK_MATCH', `${id}: definiciones repetidas`);
    pairs.forEach((p: any, j: number) => {
      if (examTextContains(p.definition, p.term)) E.push(`$.questions[${i}].pairs[${j}]`, 'EXAM_BANK_MATCH', `${id}: la definición contiene su propio término`);
      if (EXAM_MATCH_TERM_FORBIDDEN_RE.test(p.term)) E.push(`$.questions[${i}].pairs[${j}].term`, 'EXAM_BANK_MATCH', `${id}: el término no puede llevar < ni > (Moodle los borra en el desplegable)`);
    });
  }

  // ── Evidencia en el capítulo (si hay Markdown) ──
  if (ctx.chapterMd) {
    const idx = new Map<string, ExamEvidenceIndex>();
    const acceptedUnder = ctx.evidenceRules === 'asAccepted' ? (isObj(doc) && Number.isInteger(doc.bankValidationVersion) ? doc.bankValidationVersion : 1) : EXAM_BANK_VALIDATION_VERSION;
    const affirmed = acceptedUnder >= 2;
    for (const { q, i } of valid) {
      if (typeof q.chapterId !== 'string' || typeof q.evidence !== 'string') continue;
      const md = ctx.chapterMd.get(q.chapterId);
      if (typeof md !== 'string') continue;
      if (!affirmed) {
        // Reglas v1 (bancos aceptados antes de la guardia de oración): subcadena del texto normalizado.
        const ev = normalizeExamText(q.evidence);
        if (!ev || !normalizeExamText(md).includes(ev)) E.push(`$.questions[${i}].evidence`, 'EXAM_BANK_EVIDENCE', `${idOf(q, i)}: la evidencia no aparece en el texto del capítulo ${q.chapterId}`);
        continue;
      }
      if (!idx.has(q.chapterId)) idx.set(q.chapterId, examEvidenceIndex(md));
      const sup = examEvidenceSupport(idx.get(q.chapterId) as ExamEvidenceIndex, q.evidence);
      if (sup.ok === false) {
        const why = sup.reason === 'missing' ? 'la evidencia no aparece en el texto del capítulo'
          : sup.reason === 'negated' ? 'la oración del capítulo NIEGA o desmiente ese fragmento en el capítulo'
            : sup.reason === 'question' ? 'la oración del capítulo es una PREGUNTA, no una afirmación, en el capítulo'
              : 'la oración del capítulo CONDICIONA o exceptúa ese fragmento (si/excepto/salvo/cuando/pero/aunque…) en el capítulo';
        E.push(`$.questions[${i}].evidence`, 'EXAM_BANK_EVIDENCE', `${idOf(q, i)}: ${why} ${q.chapterId}`);
      }
    }
  }

  return done(questions.length);
}
