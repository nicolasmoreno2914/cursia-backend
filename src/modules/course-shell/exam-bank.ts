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
  term: [1, 120] as const,
  definition: [1, 200] as const,
  pairs: [4, 6] as const,
  distractors: 3,
});

export const EXAM_BANK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** Opciones prohibidas (Moodle baraja las opciones). Byte-idéntica en el frontend. */
export const EXAM_OPTION_FORBIDDEN_RE = /\b(todas|ninguna) (de )?las (anteriores|opciones)\b|todas son correctas/i;

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

// ─── Normalización (F2 la replica) ──────────────────────────────────────────

/** NFD, sin diacríticos, minúsculas, sin `*_#>\`[]()|`, espacios colapsados, trim. */
export function normalizeExamText(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[*_#>`[\]()|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

export interface ExamBankV1 {
  bankVersion: 1;
  scope: ExamBankScope;
  moduleId: string | null;
  plan: ExamPlanLeaf[];
  questions: ExamBankQuestion[];
}

export interface ExamBankValidationContext {
  scope: ExamBankScope;
  /** Capítulos del examen en orden del Manifest, con su módulo. */
  chapters: ReadonlyArray<{ id: string; moduleId: string }>;
  /** Markdown de cada capítulo (solo cuando está disponible: empaque). */
  chapterMd?: ReadonlyMap<string, string>;
}

export interface ExamBankValidationResult {
  ok: boolean;
  errors: ShellValidationError[];
  /** Slots del plan esperado (= preguntas que ve el estudiante). */
  slotCount: number;
  /** Preguntas del banco (0 si el documento no es legible). */
  bankSize: number;
}

// ─── 3. Validación ──────────────────────────────────────────────────────────

const TOP_KEYS = ['bankVersion', 'scope', 'moduleId', 'plan', 'questions'];
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
 * Valida un banco `dynamic_exam_bank_json` contra el contexto del examen (Manifest).
 * Códigos: MISSING_FIELD, UNKNOWN_FIELD, EXAM_BANK_SCHEMA, EXAM_BANK_PLAN,
 * EXAM_BANK_LEAF_COUNT, EXAM_BANK_DUPLICATE, EXAM_BANK_LENGTH_BIAS,
 * EXAM_BANK_OPTION_LINT, EXAM_BANK_TF_BALANCE, EXAM_BANK_MATCH, EXAM_BANK_EVIDENCE.
 * Lanza SOLO si el contexto es inválido (bug de integración, no contenido).
 */
export function validateExamBank(doc: unknown, ctx: ExamBankValidationContext): ExamBankValidationResult {
  if (ctx.scope !== 'module' && ctx.scope !== 'final') throw new Error(`EXAM_BANK_CONTEXT: scope inválido ${String(ctx.scope)}`);
  if (!ctx.chapters?.length) throw new Error('EXAM_BANK_CONTEXT: el examen no tiene capítulos');
  const expectedPlan = expectedExamPlan(ctx.scope, ctx.chapters);
  const slotCount = planSlotCount(expectedPlan);
  const E = new Errs();
  const done = (bankSize: number): ExamBankValidationResult => ({ ok: E.list.length === 0, errors: E.list, slotCount, bankSize });

  if (!isObj(doc)) {
    E.push('$', 'EXAM_BANK_SCHEMA', 'el banco debe ser un objeto JSON');
    return done(0);
  }
  E.keys(doc, TOP_KEYS, '$');
  if (doc.bankVersion !== undefined && doc.bankVersion !== EXAM_BANK_VERSION) E.push('$.bankVersion', 'EXAM_BANK_SCHEMA', `bankVersion debe ser ${EXAM_BANK_VERSION}`);
  if (doc.scope !== undefined && doc.scope !== ctx.scope) E.push('$.scope', 'EXAM_BANK_SCHEMA', `scope debe ser "${ctx.scope}"`);
  const chapterModule = new Map(ctx.chapters.map((c) => [c.id, c.moduleId]));
  if ('moduleId' in doc) {
    if (ctx.scope === 'module') {
      const expectedModule = ctx.chapters[0].moduleId;
      if (doc.moduleId !== expectedModule) E.push('$.moduleId', 'EXAM_BANK_SCHEMA', `moduleId debe ser "${expectedModule}"`);
    } else if (doc.moduleId !== null) {
      E.push('$.moduleId', 'EXAM_BANK_SCHEMA', 'moduleId debe ser null en el examen final');
    }
  }

  // Plan: idéntico (mismas hojas, mismo orden) al del servidor.
  if (doc.plan !== undefined) {
    const p = doc.plan;
    const same = Array.isArray(p) && p.length === expectedPlan.length && p.every((l, i) => isObj(l) && sameLeaf(l, expectedPlan[i]));
    if (!same) E.push('$.plan', 'EXAM_BANK_PLAN', `el plan no coincide con el del Manifest (${JSON.stringify(expectedPlan)})`);
  }

  if (doc.questions === undefined) return done(0);
  if (!Array.isArray(doc.questions)) {
    E.push('$.questions', 'EXAM_BANK_SCHEMA', 'questions debe ser una lista');
    return done(0);
  }
  const questions: unknown[] = doc.questions;

  // ── Esquema por pregunta ──
  const valid: Array<{ q: Record<string, any>; i: number; type: ExamQuestionType | null }> = [];
  questions.forEach((q, i) => {
    const path = `$.questions[${i}]`;
    if (!isObj(q)) {
      E.push(path, 'EXAM_BANK_SCHEMA', 'cada pregunta debe ser un objeto');
      return;
    }
    const type = (EXAM_QUESTION_TYPES as readonly string[]).includes(q.type) ? (q.type as ExamQuestionType) : null;
    if (q.type !== undefined && !type) E.push(`${path}.type`, 'EXAM_BANK_SCHEMA', `type debe ser ${EXAM_QUESTION_TYPES.join('|')}`);
    const allowed = [...COMMON_KEYS, ...(ctx.scope === 'final' ? ['moduleId'] : []), ...(type ? TYPE_KEYS[type] : [])];
    E.keys(q, allowed, path);
    if (q.id !== undefined && (typeof q.id !== 'string' || !EXAM_BANK_ID_RE.test(q.id))) E.push(`${path}.id`, 'EXAM_BANK_SCHEMA', 'id debe cumplir /^[A-Za-z0-9_-]{1,40}$/');
    if (q.chapterId !== undefined && (typeof q.chapterId !== 'string' || !chapterModule.has(q.chapterId))) {
      E.push(`${path}.chapterId`, 'EXAM_BANK_SCHEMA', 'chapterId no es un capítulo de este examen');
    }
    if (ctx.scope === 'final' && q.moduleId !== undefined && typeof q.chapterId === 'string' && chapterModule.has(q.chapterId) && q.moduleId !== chapterModule.get(q.chapterId)) {
      E.push(`${path}.moduleId`, 'EXAM_BANK_SCHEMA', `moduleId debe ser el módulo del capítulo ("${chapterModule.get(q.chapterId)}")`);
    }
    if (q.level !== undefined && !(EXAM_LEVELS as readonly string[]).includes(q.level)) E.push(`${path}.level`, 'EXAM_BANK_SCHEMA', `level debe ser ${EXAM_LEVELS.join('|')}`);
    E.text(q.stem, `${path}.stem`, EXAM_BANK_LIMITS.stem);
    E.text(q.explanation, `${path}.explanation`, EXAM_BANK_LIMITS.explanation);
    E.text(q.evidence, `${path}.evidence`, EXAM_BANK_LIMITS.evidence);
    if (type === 'multichoice') {
      E.option(q.correct, `${path}.correct`);
      if (q.distractors !== undefined) {
        if (!Array.isArray(q.distractors) || q.distractors.length !== EXAM_BANK_LIMITS.distractors) {
          E.push(`${path}.distractors`, 'EXAM_BANK_SCHEMA', `se esperaban exactamente ${EXAM_BANK_LIMITS.distractors} distractores`);
        } else q.distractors.forEach((d: unknown, j: number) => E.option(d, `${path}.distractors[${j}]`));
      }
    } else if (type === 'truefalse') {
      if (q.answer !== undefined && typeof q.answer !== 'boolean') E.push(`${path}.answer`, 'EXAM_BANK_SCHEMA', 'answer debe ser booleano');
      E.text(q.whyWrong, `${path}.whyWrong`, EXAM_BANK_LIMITS.whyWrong);
    } else if (type === 'match') {
      if (q.pairs !== undefined) {
        const [pmin, pmax] = EXAM_BANK_LIMITS.pairs;
        if (!Array.isArray(q.pairs) || q.pairs.length < pmin || q.pairs.length > pmax) {
          E.push(`${path}.pairs`, 'EXAM_BANK_SCHEMA', `se esperaban ${pmin}–${pmax} pares`);
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

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  // ── Duplicados (id, enunciado normalizado) ──
  const seenId = new Map<string, number>();
  const seenStem = new Map<string, number>();
  for (const { q, i } of valid) {
    if (typeof q.id === 'string') {
      if (seenId.has(q.id)) E.push(`$.questions[${i}].id`, 'EXAM_BANK_DUPLICATE', `id "${q.id}" repetido (pregunta ${seenId.get(q.id)})`);
      else seenId.set(q.id, i);
    }
    const ns = normalizeExamText(str(q.stem));
    if (ns) {
      if (seenStem.has(ns)) E.push(`$.questions[${i}].stem`, 'EXAM_BANK_DUPLICATE', `enunciado repetido (pregunta ${seenStem.get(ns)})`);
      else seenStem.set(ns, i);
    }
  }

  // ── Conteo por hoja ──
  const leafKey = (owner: string, type: string) => `${owner}\u0000${type}`;
  const ownerOf = (q: Record<string, any>): string | null => {
    if (typeof q.chapterId !== 'string' || !chapterModule.has(q.chapterId)) return null;
    return ctx.scope === 'module' ? q.chapterId : (chapterModule.get(q.chapterId) as string);
  };
  const byLeaf = new Map<string, number>();
  for (const { q, type } of valid) {
    const owner = ownerOf(q);
    if (!owner || !type) continue;
    byLeaf.set(leafKey(owner, type), (byLeaf.get(leafKey(owner, type)) ?? 0) + 1);
  }
  const planned = new Set<string>();
  for (const leaf of expectedPlan) {
    const owner = 'chapterId' in leaf ? leaf.chapterId : leaf.moduleId;
    const k = leafKey(owner, leaf.type);
    planned.add(k);
    const n = byLeaf.get(k) ?? 0;
    const min = bankFloor(leaf.slots);
    const max = bankMax(leaf.slots);
    if (n < min || n > max) {
      E.push('$.questions', 'EXAM_BANK_LEAF_COUNT', `${owner} × ${leaf.type}: ${n} preguntas, se esperaban ${min}–${max} (slots ${leaf.slots})`);
    }
  }
  for (const [k, n] of byLeaf) {
    if (!planned.has(k)) {
      const [owner, type] = k.split('\u0000');
      E.push('$.questions', 'EXAM_BANK_LEAF_COUNT', `${owner} × ${type}: ${n} preguntas fuera del plan (la hoja no tiene slots)`);
    }
  }

  // ── Selección múltiple: sesgo de longitud + lint de opciones ──
  let mcTotal = 0;
  let correctLongest = 0;
  for (const { q, i, type } of valid) {
    if (type !== 'multichoice') continue;
    if (!isObj(q.correct) || typeof q.correct.text !== 'string' || !Array.isArray(q.distractors)) continue;
    const distractors = q.distractors.filter((d: unknown) => isObj(d) && typeof (d as any).text === 'string') as ExamOption[];
    if (distractors.length !== q.distractors.length || distractors.length === 0) continue;
    const path = `$.questions[${i}]`;
    const c = len(q.correct.text);
    const longestD = Math.max(...distractors.map((d) => len(d.text)));
    mcTotal++;
    if (c > longestD) correctLongest++;
    if (c - longestD >= 8 && 100 * (c - longestD) >= 15 * longestD) {
      E.push(`${path}.correct.text`, 'EXAM_BANK_LENGTH_BIAS', `la correcta (${c}) supera al distractor más largo (${longestD}) por ≥ 8 caracteres y ≥ 15 %`);
    }
    const options = [q.correct.text, ...distractors.map((d) => d.text)];
    options.forEach((t, j) => {
      if (EXAM_OPTION_FORBIDDEN_RE.test(t)) {
        E.push(j === 0 ? `${path}.correct.text` : `${path}.distractors[${j - 1}].text`, 'EXAM_BANK_OPTION_LINT', 'opción del tipo «todas/ninguna de las anteriores»');
      }
    });
    const norm = options.map(normalizeExamText);
    for (let a = 0; a < norm.length; a++) {
      for (let b = a + 1; b < norm.length; b++) {
        if (!norm[a] || !norm[b]) continue;
        if (norm[a] === norm[b] || norm[a].includes(norm[b]) || norm[b].includes(norm[a])) {
          E.push(`${path}`, 'EXAM_BANK_OPTION_LINT', `las opciones ${a} y ${b} son iguales o una contiene a la otra`);
        }
      }
    }
  }
  if (mcTotal > 0 && 10 * correctLongest > 3 * mcTotal) {
    E.push('$.questions', 'EXAM_BANK_LENGTH_BIAS', `la correcta es la opción más larga en ${correctLongest}/${mcTotal} preguntas (> 30 %)`);
  }

  // ── Verdadero/falso: balance por hoja (capítulo en módulo, módulo en final) ──
  const tf = new Map<string, { t: number; n: number }>();
  for (const { q, type } of valid) {
    if (type !== 'truefalse' || typeof q.answer !== 'boolean') continue;
    const owner = ownerOf(q);
    if (!owner) continue;
    const s = tf.get(owner) ?? { t: 0, n: 0 };
    s.n++;
    if (q.answer) s.t++;
    tf.set(owner, s);
  }
  for (const [owner, { t, n }] of tf) {
    if (n >= 4 && (5 * t < 2 * n || 5 * t > 3 * n)) {
      E.push('$.questions', 'EXAM_BANK_TF_BALANCE', `${owner}: ${t}/${n} verdaderas (fuera de 40–60 %)`);
    } else if (n >= 2 && n <= 3 && (t === 0 || t === n)) {
      E.push('$.questions', 'EXAM_BANK_TF_BALANCE', `${owner}: ${n} preguntas V/F todas con la misma respuesta`);
    }
  }

  // ── Emparejamiento ──
  for (const { q, i, type } of valid) {
    if (type !== 'match' || !Array.isArray(q.pairs)) continue;
    const pairs = q.pairs.filter((p: unknown) => isObj(p) && typeof (p as any).term === 'string' && typeof (p as any).definition === 'string');
    const terms = pairs.map((p: any) => normalizeExamText(p.term));
    const defs = pairs.map((p: any) => normalizeExamText(p.definition));
    if (new Set(terms).size !== terms.length) E.push(`$.questions[${i}].pairs`, 'EXAM_BANK_MATCH', 'términos repetidos');
    if (new Set(defs).size !== defs.length) E.push(`$.questions[${i}].pairs`, 'EXAM_BANK_MATCH', 'definiciones repetidas');
    terms.forEach((t: string, j: number) => {
      if (t && defs[j].includes(t)) E.push(`$.questions[${i}].pairs[${j}]`, 'EXAM_BANK_MATCH', 'la definición contiene su propio término');
    });
  }

  // ── Evidencia en el capítulo (solo si hay Markdown) ──
  if (ctx.chapterMd) {
    const normMd = new Map<string, string>();
    for (const { q, i } of valid) {
      if (typeof q.chapterId !== 'string' || typeof q.evidence !== 'string') continue;
      const md = ctx.chapterMd.get(q.chapterId);
      if (typeof md !== 'string') continue;
      if (!normMd.has(q.chapterId)) normMd.set(q.chapterId, normalizeExamText(md));
      const ev = normalizeExamText(q.evidence);
      if (!ev || !(normMd.get(q.chapterId) as string).includes(ev)) {
        E.push(`$.questions[${i}].evidence`, 'EXAM_BANK_EVIDENCE', 'la evidencia no aparece en el texto del capítulo');
      }
    }
  }

  return done(questions.length);
}
