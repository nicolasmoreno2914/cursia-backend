/**
 * R11a — esquemas v3 (JSON del LLM) de `course_intro` y `module_intro`
 * (audit §E: el shell es plantilla determinística + slots de texto LLM SIN
 * cifras ni recursos) y sus validadores estrictos.
 *
 * - Texto plano: sin HTML, sin caracteres de control, sin URL/DOI/ISBN.
 * - Límites alineados con el espejo del ejecutor del navegador (R11b,
 *   `DYN_*_INTRO_V3_LIMITS` + tope de caracteres de `_dynIntroText`): el
 *   servidor nunca rechaza lo que el cliente dio por válido por un límite
 *   distinto.
 * - Lints de R2 en todo texto que el shell muestra como prosa:
 *   RESOURCE_MENTION (el LLM nunca nombra video/actividad/examen/…) y
 *   QUANTITY_CLAIM (nunca "3 módulos", "capítulo 2", "20 horas", "30 %").
 * - Bibliografía sin URL/DOI/ISBN. Los lints NO se aplican a la bibliografía
 *   (son obras citadas: "Evaluación de riesgos", "ISO 9001" son títulos
 *   legítimos) ni se muestra en los labels del shell (va al Libro Guía).
 * - Se juntan TODOS los errores (el reintento dirigido del ejecutor los lista).
 */
import { lintQuantityClaims, lintResourceMentions } from '../visual-components';
import type { ShellValidationError } from './activity-type';

export const COURSE_INTRO_V3_SCHEMA_VERSION = 1;
export const MODULE_INTRO_V3_SCHEMA_VERSION = 1;

/** Límites (palabras / cantidades / caracteres). */
export const COURSE_INTRO_V3_LIMITS = Object.freeze({
  welcomeWords: [80, 220] as const,
  welcomeMaxChars: 2000,
  competencies: [4, 6] as const,
  competencyMaxChars: 300,
  methodologyNoteMaxWords: 80,
  methodologyNoteMaxChars: 800,
  closingMaxChars: 800,
  bibliography: [5, 8] as const,
});

export const MODULE_INTRO_V3_LIMITS = Object.freeze({
  presentationMaxChars: 2000,
  outcomes: [3, 5] as const,
  outcomeMaxChars: 300,
  journeyLineMaxChars: 400,
  bibliography: [2, 4] as const,
});

export const BIBLIO_FIELD_MAX = 300;
export const BIBLIO_YEAR_RANGE = [1500, 2100] as const;

export interface BibliographyEntry {
  author: string;
  title: string;
  year: number;
  publisher: string;
}

export interface CourseIntroV3 {
  schemaVersion: 1;
  welcome: string;
  competencies: string[];
  methodology_note: string;
  closing: string;
  bibliography: BibliographyEntry[];
}

export interface ModuleIntroJourneyLine {
  chapterId: string;
  line: string;
}

export interface ModuleIntroV3 {
  schemaVersion: 1;
  presentation: string;
  outcomes: string[];
  journey: ModuleIntroJourneyLine[];
  bibliography: BibliographyEntry[];
}

export interface IntroValidationResult {
  ok: boolean;
  errors: ShellValidationError[];
}

// ─── helpers ────────────────────────────────────────────────────────────────

const HTML_TAG_RE = /<(?:\/?[a-zA-Z]|!|\?)/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Misma expresión que DYN_INTRO_URL_RE del ejecutor (R11b). */
const URL_RE = /(https?:\/\/|www\.|\bdoi\s*:|\b10\.\d{4,9}\/\S+|\bisbn\b)/i;

// ─── Lint de prosa del shell (fix round 1, review G5 C1) ───────────────────
// Los textos LLM que el shell muestra como prosa NO pueden traer cifras: toda
// cifra visible sale de facts. Se rechaza:
//  - DIGIT_IN_TEXT: cualquier dígito (la bibliografía queda exenta: años);
//  - QUANTITY_CLAIM: número escrito en palabras junto a un sustantivo de
//    estructura o de tiempo ("tres módulos", "una docena de lecciones");
//  - FORBIDDEN_CLAIM: afirmaciones que el shell nunca puede respaldar (§E):
//    certificado/certificación/diploma, PDF, narración profesional, horas,
//    minutos, semanas.
// "un/una" no cuentan como número (demasiado frecuentes en prosa normal).
const NUMBER_WORDS =
  '(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|' +
  'veinte|veinti[a-z]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|docena|decena|par)';
const STRUCTURE_OR_TIME_NOUNS =
  '(?:modulos?|capitulos?|videos?|actividad(?:es)?|preguntas?|intentos?|minutos?|horas?|paginas?|semanas?|dias?|meses|mes|anos?|' +
  'lecciones|leccion|unidad(?:es)?|sesion(?:es)?|clases?|ejercicios?|creditos?|temas?|diapositivas?|palabras?|niveles?|etapas?|' +
  'evaluacion(?:es)?|examen(?:es)?|cuestionarios?|pruebas?|juegos?|presentacion(?:es)?|partes?|secciones?|bloques?)';
const LB = '(?<![\\p{L}\\p{N}_])';
const RB = '(?![\\p{L}\\p{N}_])';
const NUMBER_WORD_RE = new RegExp(`${LB}${NUMBER_WORDS}\\s+(?:(?:de|del|los|las|sus|[\\p{L}]+)\\s+){0,2}${STRUCTURE_OR_TIME_NOUNS}${RB}`, 'gu');
const FORBIDDEN_CLAIM_RE = new RegExp(
  `${LB}(?:certificad[oa]s?|certificacion(?:es)?|certificar|diplomas?|pdf|narracion(?:es)? profesional(?:es)?|narrad[oa]s? profesionalmente|locucion profesional|horas|minutos|semanas)${RB}`,
  'gu',
);

function normalizeLint(text: string): string {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase().replace(/\*\*/g, '').replace(/\s+/g, ' ');
}

export interface ShellProseHit {
  code: 'DIGIT_IN_TEXT' | 'QUANTITY_CLAIM' | 'FORBIDDEN_CLAIM';
  match: string;
}

/** Lint de los textos LLM que el shell renderiza como prosa (sin cifras, sin afirmaciones prohibidas). */
export function lintShellProse(text: string): ShellProseHit[] {
  const hits: ShellProseHit[] = [];
  for (const m of String(text ?? '').matchAll(/\p{Nd}+/gu)) hits.push({ code: 'DIGIT_IN_TEXT', match: m[0] });
  const norm = normalizeLint(text);
  for (const m of norm.matchAll(NUMBER_WORD_RE)) hits.push({ code: 'QUANTITY_CLAIM', match: m[0] });
  for (const m of norm.matchAll(FORBIDDEN_CLAIM_RE)) hits.push({ code: 'FORBIDDEN_CLAIM', match: m[0] });
  return hits;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function wordCount(text: string): number {
  const t = String(text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

interface TextRule {
  maxChars?: number;
  words?: readonly [number, number];
  maxWords?: number;
  /** Aplica RESOURCE_MENTION y QUANTITY_CLAIM (default true). */
  lint?: boolean;
}

function checkText(v: unknown, path: string, rule: TextRule, errors: ShellValidationError[]): void {
  if (typeof v !== 'string') {
    errors.push({ path, code: v === undefined ? 'MISSING_FIELD' : 'TYPE_MISMATCH', message: 'se esperaba texto' });
    return;
  }
  if (!v.trim()) {
    errors.push({ path, code: 'TEXT_EMPTY', message: 'texto vacío' });
    return;
  }
  if (rule.maxChars !== undefined && Array.from(v).length > rule.maxChars) {
    errors.push({ path, code: 'TEXT_TOO_LONG', message: `${Array.from(v).length} caracteres > ${rule.maxChars}` });
  }
  const wc = wordCount(v);
  if (rule.words && (wc < rule.words[0] || wc > rule.words[1])) {
    errors.push({ path, code: 'WORD_RANGE', message: `${wc} palabras, se esperaban ${rule.words[0]}–${rule.words[1]}` });
  }
  if (rule.maxWords !== undefined && wc > rule.maxWords) {
    errors.push({ path, code: 'WORD_RANGE', message: `${wc} palabras > ${rule.maxWords}` });
  }
  if (HTML_TAG_RE.test(v)) errors.push({ path, code: 'HTML_IN_TEXT', message: 'texto con forma de etiqueta HTML' });
  if (CONTROL_RE.test(v)) errors.push({ path, code: 'TEXT_FORMAT', message: 'caracteres de control no permitidos' });
  if (URL_RE.test(v)) errors.push({ path, code: 'URL_IN_TEXT', message: 'no se permiten URLs, DOIs ni ISBN' });
  if (rule.lint !== false) {
    for (const h of lintResourceMentions(v)) errors.push({ path, code: 'RESOURCE_MENTION', message: `menciona un recurso: "${h.match}"` });
    for (const h of lintQuantityClaims(v)) errors.push({ path, code: 'QUANTITY_CLAIM', message: `afirma una cantidad: "${h.match}"` });
    for (const h of lintShellProse(v)) {
      const what = h.code === 'DIGIT_IN_TEXT' ? 'cifra (las cifras las pone Cursia desde facts)' : h.code === 'FORBIDDEN_CLAIM' ? 'afirmación no respaldada' : 'cantidad en palabras';
      errors.push({ path, code: h.code, message: `${what}: "${h.match}"` });
    }
  }
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], path: string, errors: ShellValidationError[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push({ path: `${path}.${k}`, code: 'UNKNOWN_FIELD', message: `campo no permitido "${k}"` });
  }
}

function checkList(v: unknown, path: string, range: readonly [number, number], errors: ShellValidationError[]): v is unknown[] {
  if (!Array.isArray(v)) {
    errors.push({ path, code: v === undefined ? 'MISSING_FIELD' : 'TYPE_MISMATCH', message: 'se esperaba una lista' });
    return false;
  }
  if (v.length < range[0] || v.length > range[1]) {
    errors.push({ path, code: 'COUNT_RANGE', message: `${v.length} elementos, se esperaban ${range[0]}–${range[1]}` });
  }
  return true;
}

function checkBibliography(v: unknown, path: string, range: readonly [number, number], errors: ShellValidationError[]): void {
  if (!checkList(v, path, range, errors)) return;
  v.forEach((e, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(e)) {
      errors.push({ path: p, code: 'NOT_OBJECT', message: 'cada referencia es {author, title, year, publisher}' });
      return;
    }
    checkKeys(e, ['author', 'title', 'year', 'publisher'], p, errors);
    for (const f of ['author', 'title', 'publisher']) {
      checkText(e[f], `${p}.${f}`, { maxChars: BIBLIO_FIELD_MAX, lint: false }, errors);
    }
    if (!Number.isInteger(e.year) || (e.year as number) < BIBLIO_YEAR_RANGE[0] || (e.year as number) > BIBLIO_YEAR_RANGE[1]) {
      errors.push({
        path: `${p}.year`,
        code: e.year === undefined ? 'MISSING_FIELD' : 'TYPE_MISMATCH',
        message: `year debe ser un entero entre ${BIBLIO_YEAR_RANGE[0]} y ${BIBLIO_YEAR_RANGE[1]}`,
      });
    }
  });
}

// ─── course_intro v3 ────────────────────────────────────────────────────────

export function validateCourseIntroV3(doc: unknown): IntroValidationResult {
  const L = COURSE_INTRO_V3_LIMITS;
  const errors: ShellValidationError[] = [];
  if (!isPlainObject(doc)) return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el documento debe ser un objeto' }] };
  checkKeys(doc, ['schemaVersion', 'welcome', 'competencies', 'methodology_note', 'closing', 'bibliography'], '$', errors);
  if (doc.schemaVersion !== COURSE_INTRO_V3_SCHEMA_VERSION) {
    errors.push({ path: '$.schemaVersion', code: 'SCHEMA_VERSION', message: `schemaVersion debe ser ${COURSE_INTRO_V3_SCHEMA_VERSION}` });
  }
  checkText(doc.welcome, '$.welcome', { words: L.welcomeWords, maxChars: L.welcomeMaxChars }, errors);
  if (checkList(doc.competencies, '$.competencies', L.competencies, errors)) {
    (doc.competencies as unknown[]).forEach((c, i) => checkText(c, `$.competencies[${i}]`, { maxChars: L.competencyMaxChars }, errors));
  }
  checkText(doc.methodology_note, '$.methodology_note', { maxWords: L.methodologyNoteMaxWords, maxChars: L.methodologyNoteMaxChars }, errors);
  checkText(doc.closing, '$.closing', { maxChars: L.closingMaxChars }, errors);
  checkBibliography(doc.bibliography, '$.bibliography', L.bibliography, errors);
  return { ok: errors.length === 0, errors };
}

// ─── module_intro v3 ────────────────────────────────────────────────────────

/**
 * `expect.chapterIds`: ids de los capítulos del módulo EN ORDEN del Manifest.
 * El journey debe tenerlos exactamente, en ese orden (ni faltantes, ni extras,
 * ni reordenados).
 */
export function validateModuleIntroV3(doc: unknown, expect: { chapterIds: string[] }): IntroValidationResult {
  const L = MODULE_INTRO_V3_LIMITS;
  const errors: ShellValidationError[] = [];
  if (!Array.isArray(expect?.chapterIds) || expect.chapterIds.length === 0) {
    throw new Error('MODULE_INTRO_EXPECT_INVALID: chapterIds debe ser una lista no vacía');
  }
  if (!isPlainObject(doc)) return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el documento debe ser un objeto' }] };
  checkKeys(doc, ['schemaVersion', 'presentation', 'outcomes', 'journey', 'bibliography'], '$', errors);
  if (doc.schemaVersion !== MODULE_INTRO_V3_SCHEMA_VERSION) {
    errors.push({ path: '$.schemaVersion', code: 'SCHEMA_VERSION', message: `schemaVersion debe ser ${MODULE_INTRO_V3_SCHEMA_VERSION}` });
  }
  checkText(doc.presentation, '$.presentation', { maxChars: L.presentationMaxChars }, errors);
  if (checkList(doc.outcomes, '$.outcomes', L.outcomes, errors)) {
    (doc.outcomes as unknown[]).forEach((o, i) => checkText(o, `$.outcomes[${i}]`, { maxChars: L.outcomeMaxChars }, errors));
  }
  if (Array.isArray(doc.journey)) {
    const got: string[] = [];
    doc.journey.forEach((j, i) => {
      const p = `$.journey[${i}]`;
      if (!isPlainObject(j)) {
        errors.push({ path: p, code: 'NOT_OBJECT', message: 'cada paso es {chapterId, line}' });
        return;
      }
      checkKeys(j, ['chapterId', 'line'], p, errors);
      if (typeof j.chapterId !== 'string') errors.push({ path: `${p}.chapterId`, code: 'TYPE_MISMATCH', message: 'chapterId debe ser texto' });
      got.push(String(j.chapterId));
      checkText(j.line, `${p}.line`, { maxChars: L.journeyLineMaxChars }, errors);
    });
    if (JSON.stringify(got) !== JSON.stringify(expect.chapterIds)) {
      errors.push({
        path: '$.journey',
        code: 'JOURNEY_MISMATCH',
        message: `los chapterId del journey deben ser exactamente [${expect.chapterIds.join(', ')}] en ese orden (llegó [${got.join(', ')}])`,
      });
    }
  } else {
    errors.push({ path: '$.journey', code: doc.journey === undefined ? 'MISSING_FIELD' : 'TYPE_MISMATCH', message: 'journey debe ser una lista' });
  }
  checkBibliography(doc.bibliography, '$.bibliography', L.bibliography, errors);
  return { ok: errors.length === 0, errors };
}

function assertValid(r: IntroValidationResult, what: string): void {
  if (!r.ok) {
    const head = r.errors.slice(0, 6).map((e) => `${e.path} ${e.code}`).join('; ');
    throw new Error(`${what}_INVALID: ${r.errors.length} error(es): ${head}`);
  }
}

export function assertValidCourseIntroV3(doc: unknown): CourseIntroV3 {
  assertValid(validateCourseIntroV3(doc), 'COURSE_INTRO_V3');
  return doc as CourseIntroV3;
}

export function assertValidModuleIntroV3(doc: unknown, expect: { chapterIds: string[] }): ModuleIntroV3 {
  assertValid(validateModuleIntroV3(doc, expect), 'MODULE_INTRO_V3');
  return doc as ModuleIntroV3;
}
